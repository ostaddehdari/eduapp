export interface Offer {
  id: string;
  code: string;
  version: number;
  priceMinor: string;
  currency: string;
  modules: string[];
  quotas: Record<string, number>;
  trialDays: number;
  termDays: number;
}

export function readOffers(payload: unknown): Offer[] {
  if (!payload || typeof payload !== 'object' || !('data' in payload) || !Array.isArray(payload.data)) {
    throw new Error('فهرست پلن‌ها در دسترس نیست.');
  }
  return payload.data.filter((offer: unknown): offer is Offer => {
    if (!offer || typeof offer !== 'object') return false;
    const o = offer as Record<string, unknown>;
    return typeof o.id === 'string' && typeof o.code === 'string' &&
      Number.isSafeInteger(o.version) && typeof o.priceMinor === 'string' &&
      /^\d{1,15}$/.test(o.priceMinor) && o.currency === 'IRR' &&
      Array.isArray(o.modules) && o.modules.every((module: unknown) => typeof module === 'string') &&
      !!o.quotas && typeof o.quotas === 'object' &&
      Number.isSafeInteger((o.quotas as Record<string, unknown>).seats) &&
      Number.isSafeInteger(o.trialDays) && Number.isSafeInteger(o.termDays);
  });
}

export function purchaseSummary(offer: Offer, modules: string[], seats: number) {
  const availableSeats = offer.quotas.seats;
  if (!Number.isSafeInteger(seats) || seats < 1 || typeof availableSeats !== 'number' || seats > availableSeats ||
    new Set(modules).size !== modules.length || !modules.every(module => offer.modules.includes(module))) {
    throw new Error('انتخاب ماژول یا تعداد صندلی معتبر نیست.');
  }
  return {
    planVersionId: offer.id,
    owner: 'سرویس صورتحساب EduApp',
    modules: [...modules].sort(), seats,
    amountMinor: offer.priceMinor, currency: offer.currency,
    termDays: offer.termDays, trialDays: offer.trialDays,
    // The catalog has a flat price, not per-seat or per-module prices.
    pricingNote: 'این مبلغ برای کل پلن است؛ انتخاب ماژول و صندلی قیمت را تغییر نمی‌دهد.',
  };
}
