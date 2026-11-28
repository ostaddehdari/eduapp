import assert from 'node:assert/strict';
import test from 'node:test';
import { purchaseSummary, readOffers } from '../../apps/public-web/app/purchase';

const offer = {
  id: 'v1', code: 'school_plus', version: 1, priceMinor: '100000', currency: 'IRR',
  modules: ['school', 'attendance'], quotas: { seats: 100 }, trialDays: 14, termDays: 365,
};
test('a published plan gives an honest pre-payment summary with owner and terms', () => {
  const [item] = readOffers({ data: [offer] });
  const summary = purchaseSummary(item, ['attendance'], 25);
  assert.equal(summary.amountMinor, '100000');
  assert.equal(summary.seats, 25);
  assert.equal(summary.termDays, 365);
  assert.match(summary.owner, /صورتحساب/);
  assert.match(summary.pricingNote, /قیمت را تغییر نمی‌دهد/);
});
test('unavailable catalog and out-of-range selections fail closed', () => {
  assert.deepEqual(readOffers({ data: [{ ...offer, priceMinor: '-1' }] }), []);
  assert.throws(() => readOffers({ error: 'SERVICE_UNAVAILABLE' }));
  assert.throws(() => purchaseSummary(offer, ['foreign_module'], 1));
  assert.throws(() => purchaseSummary(offer, ['school'], 101));
});
