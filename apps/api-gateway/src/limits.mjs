import { randomBytes } from 'node:crypto';

class BoundedEntries {
  #entries = new Map();
  #clock;
  #capacity;

  constructor(clock, capacity) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new TypeError('Invalid capacity');
    this.#clock = clock;
    this.#capacity = capacity;
  }

  get(key, now = this.#clock()) {
    const record = this.#entries.get(key);
    if (!record) return undefined;
    if (record.expiresAt <= now) {
      this.#entries.delete(key);
      return undefined;
    }
    return record.value;
  }

  add(key, value, expiresAt, now = this.#clock()) {
    if (this.#entries.size >= this.#capacity) {
      for (const [storedKey, record] of this.#entries) {
        if (record.expiresAt <= now) this.#entries.delete(storedKey);
      }
    }
    if (this.#entries.size >= this.#capacity) throw new Error('Capacity exhausted');
    this.#entries.set(key, { value, expiresAt });
  }
}

export function createMemoryRateLimiter({ clock = Date.now, capacity = 10_000 } = {}) {
  const entries = new BoundedEntries(clock, capacity);
  return {
    consume(key, { max, windowSeconds }) {
      const now = clock();
      let bucket = entries.get(key, now);
      if (!bucket) {
        const expiresAt = now + windowSeconds * 1000;
        bucket = { count: 0, expiresAt };
        entries.add(key, bucket, expiresAt, now);
      }
      if (bucket.count >= max) return { retryAfter: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)) };
      bucket.count += 1;
      return { retryAfter: null };
    },
  };
}

export function createMemoryCursorStore({ clock = Date.now, capacity = 10_000 } = {}) {
  const entries = new BoundedEntries(clock, capacity);
  return {
    read(token, binding) {
      const record = entries.get(token);
      return record?.binding === binding ? structuredClone(record.position) : undefined;
    },
    issue(binding, position, ttlSeconds) {
      const token = randomBytes(32).toString('base64url');
      entries.add(token, { binding, position: structuredClone(position) }, clock() + ttlSeconds * 1000);
      return token;
    },
  };
}
