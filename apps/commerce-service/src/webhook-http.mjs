import { PaymentError } from './payments.mjs';

export function createPaymentWebhookHandler({ service, providerName }) {
  if (typeof service?.callback !== 'function' || typeof providerName !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(providerName)) throw new TypeError('A verified payment service is required');
  const route = `/v1/webhooks/payments/${providerName}`;
  return async function webhook(req, res) {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'POST' || req.url !== route) { res.writeHead(404); res.end(); return; }
    try {
      if (String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new PaymentError('INVALID_WEBHOOK');
      }
      let size = 0;
      const chunks = [];
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 8192) throw new PaymentError('INVALID_WEBHOOK');
        chunks.push(chunk);
      }
      const result = await service.callback({ rawBody: Buffer.concat(chunks),
        signature: req.headers['x-payment-signature'], timestamp: Number(req.headers['x-payment-timestamp']) });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ accepted: result.paid, replayed: result.replayed }));
    } catch (error) {
      const code = error instanceof PaymentError ? error.message : 'SERVICE_UNAVAILABLE';
      const status = ['INVALID_SIGNATURE', 'UNVERIFIED'].includes(code) ? 401 :
        ['INVALID_WEBHOOK', 'INVALID_REQUEST'].includes(code) ? 400 :
          ['CONFLICT', 'NOT_FOUND'].includes(code) ? 409 : 503;
      res.writeHead(status); res.end();
    }
  };
}
