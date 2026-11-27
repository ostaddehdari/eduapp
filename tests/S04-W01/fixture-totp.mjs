import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

export function fixtureCode(secret, instant) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  assert.match(secret, /^[A-Z2-7]+$/);
  const bits = [...secret].map(char => alphabet.indexOf(char).toString(2).padStart(5, '0')).join('');
  const seed = Buffer.from(bits.match(/[01]{8}/g).map(byte => Number.parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(instant / 30_000)));
  const digest = createHmac('sha1', seed).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
