import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import test from 'node:test';
import { consumeNext } from '../../apps/worker/event-delivery/delivery.mjs';
import { consumerNames, eventRoutes } from '../../apps/worker/event-delivery/event-contract.mjs';
import { localFixtureUrl } from './service-url.mjs';

const TENANT_A = '50000000-0000-0000-0000-000000000001';
const TENANT_B = '50000000-0000-0000-0000-000000000002';
const CONSUMER = 'tenancy_organization';
const allowedTenants = new Set([TENANT_A, TENANT_B]);

function activation(tenantId) {
  return {
    id: randomUUID(), tenantId, type: 'billing.subscription_activated.v1',
    occurredAt: '2026-01-01T10:00:00.000Z', payload: { subscription_id: randomUUID(), activation_revision: 1 },
  };
}

function transactionFixture(events) {
  const outbox = new Map(events.map(event => [event.id, event]));
  const inbox = new Set();
  return {
    get pending() { return outbox.size; },
    async publishNext(tenant, publish) {
      const event = [...outbox.values()].find(event => event.tenantId === tenant);
      if (!event) return false;
      await publish(event);
      outbox.delete(event.id);
      return true;
    },
    async consume(consumer, event, handle) {
      const key = `${consumer}:${event.id}`;
      if (inbox.has(key)) return 'duplicate';
      await handle(event);
      inbox.add(key);
      return 'handled';
    },
  };
}

function brokerFixture() {
  const deliveries = [];
  const deadLetters = [];
  let online = true;
  const requireOnline = () => { if (!online) throw new Error('broker_offline'); };
  return {
    deadLetters,
    disconnect: () => { online = false; },
    reconnect: () => { online = true; },
    async publish(event) {
      requireOnline();
      await this.retry(CONSUMER, event, 1);
    },
    async retry(consumer, event, attempt) {
      requireOnline();
      deliveries.push({ consumer, body: JSON.stringify(event), attempt });
    },
    async deadLetter(consumer, record) {
      requireOnline();
      deadLetters.push({ consumer, record });
    },
    async receive(consumer) {
      requireOnline();
      const index = deliveries.findIndex(entry => entry.consumer === consumer);
      if (index === -1) return null;
      const delivery = deliveries[index];
      return {
        body: delivery.body, attempt: delivery.attempt,
        ack: () => { deliveries.splice(deliveries.indexOf(delivery), 1); },
        requeue: () => {},
      };
    },
  };
}

test('broker routes follow the versioned owner and consumer contract', async () => {
  const contract = JSON.parse(await readFile(new URL('../../docs/contracts/S01-W03.json', import.meta.url), 'utf8'));
  assert.deepEqual(eventRoutes, Object.fromEntries(contract.event_contracts.map(event => [event.type, event.consumers])));
});

test('outage retains the outbox row and replay preserves one effect per tenant', async () => {
  const [a, b] = [...allowedTenants].map(activation);
  const store = transactionFixture([a, b]);
  const broker = brokerFixture();
  const effects = [];
  const options = { store, broker, consumer: CONSUMER, allowedTenants, handle: async event => { effects.push(event.tenantId); } };
  broker.disconnect();
  await assert.rejects(store.publishNext(TENANT_A, broker.publish.bind(broker)), /broker_offline/);
  assert.equal(store.pending, 2);
  broker.reconnect();
  for (const tenant of allowedTenants) assert.equal(await store.publishNext(tenant, broker.publish.bind(broker)), true);
  assert.equal(store.pending, 0);
  await broker.publish(a);
  await broker.publish(b);
  for (let i = 0; i < 4; i++) assert.equal(await consumeNext(options), true);
  assert.equal(await consumeNext(options), false);
  assert.deepEqual(effects, [TENANT_A, TENANT_B]);
});

test('a failed handler retries and then writes a sanitized dead letter', async () => {
  const event = activation(TENANT_A);
  const store = transactionFixture([]);
  const broker = brokerFixture();
  let attempts = 0;
  const options = {
    store, broker, consumer: CONSUMER, allowedTenants, maxAttempts: 2,
    async handle() { attempts++; throw new Error('private payload detail'); },
  };
  await broker.publish(event);
  assert.equal(await consumeNext(options), true);
  assert.deepEqual(broker.deadLetters, []);
  assert.equal(await consumeNext(options), true);
  assert.equal(await consumeNext(options), false);
  assert.equal(attempts, 2);
  assert.deepEqual(broker.deadLetters, [{ consumer: CONSUMER, record: {
    id: event.id, tenantId: TENANT_A, type: event.type, attempt: 2, code: 'handler_failed',
  } }]);
});

const brokerUrl = process.env.EDUAPP_TEST_AMQP_URL;
test('RabbitMQ confirms after reconnect, delivers redelivery, and holds a dead letter', { skip: !brokerUrl, timeout: 30_000 }, async (t) => {
  const amqpUrl = localFixtureUrl(brokerUrl, ['amqp:', 'amqps:']).href;
  const { openRabbitMqBroker } = await import('../../apps/worker/event-delivery/rabbitmq.mjs');
  const amqp = createRequire(new URL('../../apps/worker/package.json', import.meta.url))('amqplib');
  const namespace = `eduapp.test.${randomUUID()}`;
  let broker = await openRabbitMqBroker({ url: amqpUrl, namespace });
  const observer = await amqp.connect(amqpUrl);
  const channel = await observer.createChannel();
  t.after(async () => {
    await broker.close();
    for (const name of consumerNames) {
      await channel.deleteQueue(`${namespace}.${name}`);
      await channel.deleteQueue(`${namespace}.${name}.dlq`);
    }
    await observer.close();
  });
  const event = activation(TENANT_A);
  const store = transactionFixture([event]);
  await broker.close();
  await assert.rejects(store.publishNext(TENANT_A, broker.publish));
  assert.equal(store.pending, 1);
  broker = await openRabbitMqBroker({ url: amqpUrl, namespace });
  assert.equal(await store.publishNext(TENANT_A, broker.publish), true);

  const unsettled = await broker.receive(CONSUMER);
  assert.equal(JSON.parse(unsettled.body).id, event.id);
  await broker.close();
  broker = await openRabbitMqBroker({ url: amqpUrl, namespace });
  let effects = 0;
  const options = { store, broker, consumer: CONSUMER, allowedTenants, handle: async () => { effects++; } };
  assert.equal(await consumeNext(options), true);
  await broker.publish(event);
  assert.equal(await consumeNext(options), true);
  assert.equal(effects, 1);

  const failed = activation(TENANT_A);
  await broker.publish(failed);
  assert.equal(await consumeNext({ ...options, maxAttempts: 1, handle: async () => { throw new Error('private detail'); } }), true);
  const dlq = await channel.get(`${namespace}.${CONSUMER}.dlq`, { noAck: true });
  assert.deepEqual(JSON.parse(dlq.content), {
    id: failed.id, tenantId: TENANT_A, type: failed.type, attempt: 1, code: 'handler_failed',
  });
});
