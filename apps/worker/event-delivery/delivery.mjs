import { setTimeout as delay } from 'node:timers/promises';
import { consumerNames, eventRoutes, InvalidDelivery, isUuid, validateEvent } from './event-contract.mjs';

export async function consumeNext({ store, broker, consumer, allowedTenants, handle, maxAttempts = 3 }) {
  if (!consumerNames.includes(consumer) || typeof handle !== 'function' ||
    !Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new TypeError('invalid_consumer_configuration');

  const message = await broker.receive(consumer);
  if (!message) return false;
  let event;
  let code;
  const attempt = Number.isSafeInteger(message.attempt) && message.attempt >= 1 ? message.attempt : 1;
  try {
    try {
      event = validateEvent(JSON.parse(message.body));
    } catch {
      throw new InvalidDelivery('invalid_event');
    }
    if (!eventRoutes[event.type].includes(consumer)) throw new InvalidDelivery('invalid_route');
    if (!allowedTenants.has(event.tenantId.toLowerCase())) throw new InvalidDelivery('tenant_not_registered');
    if (attempt > maxAttempts) throw new InvalidDelivery('retry_limit');
    await store.consume(consumer, event, handle);
  } catch (error) {
    const permanent = ['invalid_event', 'invalid_route', 'tenant_not_registered', 'retry_limit', 'tenant_conflict'];
    code = error instanceof InvalidDelivery && permanent.includes(error.code) ? error.code : 'handler_failed';
  }

  if (!code) {
    await message.ack();
    return true;
  }

  try {
    if (code === 'handler_failed' && attempt < maxAttempts) {
      await delay(Math.min(100 * (2 ** (attempt - 1)), 1_000));
      await broker.retry(consumer, event, attempt + 1);
    } else {
      await broker.deadLetter(consumer, {
        id: isUuid(event?.id) ? event.id : null,
        tenantId: isUuid(event?.tenantId) ? event.tenantId : null,
        type: event?.type ?? null,
        attempt,
        code,
      });
    }
  } catch (error) {
    // Keep the unsettled message on broker transfer failure. A closed channel requeues it itself.
    await message.requeue();
    throw error;
  }
  await message.ack();
  return true;
}

export async function runDelivery({ store, openBroker, tenants, handlers, signal, onUnavailable = () => {} }) {
  const allowedTenants = new Set(tenants.map(tenant => tenant.toLowerCase()));
  if (!allowedTenants.size || [...allowedTenants].some(tenant => !isUuid(tenant))) {
    throw new TypeError('invalid_tenant_allowlist');
  }
  for (const [consumer, handle] of Object.entries(handlers)) {
    if (!consumerNames.includes(consumer) || typeof handle !== 'function') throw new TypeError('invalid_consumer_configuration');
  }
  const pause = async (milliseconds) => {
    try {
      await delay(milliseconds, undefined, { signal });
    } catch (error) {
      if (error.name !== 'AbortError') throw error;
    }
  };
  let backoff = 200;
  while (!signal.aborted) {
    let broker;
    try {
      broker = await openBroker();
      while (!signal.aborted) {
        let progressed = false;
        for (const tenant of allowedTenants) {
          if (signal.aborted) break;
          progressed = (await store.publishNext(tenant, event => broker.publish(event))) || progressed;
        }
        for (const [consumer, handle] of Object.entries(handlers)) {
          if (signal.aborted) break;
          progressed = (await consumeNext({ store, broker, consumer, handle, allowedTenants })) || progressed;
        }
        backoff = 200;
        if (!progressed) await pause(250);
      }
    } catch {
      if (!signal.aborted) onUnavailable();
    } finally {
      if (broker) await broker.close();
    }
    if (!signal.aborted) await pause(backoff);
    backoff = Math.min(backoff * 2, 5_000);
  }
}
