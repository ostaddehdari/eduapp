import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { createPaymentWebhookHandler } from '../../apps/commerce-service/src/webhook-http.mjs';
import { PaymentError } from '../../apps/commerce-service/src/payments.mjs';

test('webhook adapter forwards raw bytes only on exact provider route and hides errors', async t => {
  const seen = [];
  const server = createServer(createPaymentWebhookHandler({ providerName: 'fixture',
    service: { async callback(input) { seen.push(input); if (input.signature === 'bad') throw new PaymentError('INVALID_SIGNATURE');
      return { paid: true, replayed: false }; } },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}/v1/webhooks/payments/`;
  const send = (provider, signature, body = '{ "eventId": "a" }') => fetch(base + provider, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-payment-signature': signature, 'x-payment-timestamp': '123' }, body });
  assert.equal((await send('other', 'ok')).status, 404);
  assert.equal((await send('fixture', 'bad')).status, 401);
  const accepted = await send('fixture', 'ok');
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { accepted: true, replayed: false });
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1].rawBody, Buffer.from('{ "eventId": "a" }'));
  assert.equal(seen[1].timestamp, 123);
  assert.equal((await send('fixture', 'ok', 'x'.repeat(8193))).status, 400);
  assert.equal(seen.length, 2);
});
