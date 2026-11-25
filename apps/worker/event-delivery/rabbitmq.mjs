import { Buffer } from 'node:buffer';
import { randomUUID } from 'node:crypto';
import { clearTimeout, setTimeout } from 'node:timers';
import amqp from 'amqplib';
import { consumerNames, eventRoutes, validateEvent } from './event-contract.mjs';

export async function openRabbitMqBroker({ url, namespace = 'eduapp.events.v1', timeout = 5_000 }) {
  if (!/^[a-z0-9._-]{1,96}$/.test(namespace)) throw new TypeError('invalid_queue_namespace');
  const connection = await amqp.connect(url, { timeout });
  connection.on('error', () => {});
  const queue = consumer => `${namespace}.${consumer}`;
  const dlq = consumer => `${queue(consumer)}.dlq`;
  let channel;
  try {
    channel = await connection.createConfirmChannel();
    channel.on('error', () => {});
    for (const consumer of consumerNames) {
      await channel.assertQueue(queue(consumer), { durable: true });
      await channel.assertQueue(dlq(consumer), { durable: true });
    }
  } catch (error) {
    await connection.close().catch(() => {});
    throw error;
  }

  const returned = new Map();
  channel.on('return', message => returned.get(message.properties.correlationId)?.());
  async function confirmedSend(destination, value, attempt) {
    const correlationId = randomUUID();
    try {
      await new Promise((resolve, reject) => {
        const deadline = setTimeout(() => reject(new Error('publisher_confirmation_timeout')), timeout);
        const finish = (error) => {
          clearTimeout(deadline);
          if (error) reject(error);
          else resolve();
        };
        returned.set(correlationId, () => finish(new Error('broker_unroutable')));
        try {
          channel.sendToQueue(destination, Buffer.from(JSON.stringify(value)), {
            correlationId, persistent: true, mandatory: true, contentType: 'application/json',
            headers: { 'x-eduapp-attempt': attempt },
          }, finish);
        } catch (error) {
          finish(error);
        }
      });
    } finally {
      returned.delete(correlationId);
    }
  }

  return {
    async publish(event) {
      validateEvent(event);
      for (const consumer of eventRoutes[event.type]) await confirmedSend(queue(consumer), event, 1);
    },
    retry: (consumer, event, attempt) => confirmedSend(queue(consumer), event, attempt),
    deadLetter: (consumer, record) => confirmedSend(dlq(consumer), record, record.attempt),
    async receive(consumer) {
      const delivery = await channel.get(queue(consumer), { noAck: false });
      if (!delivery) return null;
      return {
        body: delivery.content.toString('utf8'),
        attempt: delivery.properties.headers?.['x-eduapp-attempt'],
        ack: () => channel.ack(delivery),
        requeue: () => channel.nack(delivery, false, true),
      };
    },
    close: () => connection.close().catch(() => {}),
  };
}
