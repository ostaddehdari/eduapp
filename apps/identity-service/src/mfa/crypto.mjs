import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PATTERN = /^[0-9]{6}$/;
export const RECOVERY_CODE_PATTERN = /^[A-Za-z0-9_-]{27}$/;

function base32(bytes) {
  let output = '';
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += ALPHABET[(value >>> bits) & 31];
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

export function enrollmentMaterial() {
  const seed = randomBytes(20);
  return { seed, secret: base32(seed) };
}

export function protectSeed(key, identityId, seed) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('eduapp-mfa:v1:' + identityId));
  const encrypted = Buffer.concat([cipher.update(seed), cipher.final()]);
  return ['v1', nonce, cipher.getAuthTag(), encrypted].map((part) =>
    typeof part === 'string' ? part : part.toString('base64url')).join('.');
}

export function unprotectSeed(key, identityId, encrypted) {
  const [version, nonce, tag, body] = encrypted.split('.');
  if (version !== 'v1') throw new Error('Unknown authenticator key version');
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(nonce, 'base64url'));
  cipher.setAAD(Buffer.from('eduapp-mfa:v1:' + identityId));
  cipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([cipher.update(Buffer.from(body, 'base64url')), cipher.final()]);
}

function totpAt(seed, counter) {
  const input = Buffer.alloc(8);
  input.writeBigUInt64BE(BigInt(counter));
  const checksum = createHmac('sha1', seed).update(input).digest();
  const offset = checksum.at(-1) & 15;
  return String((checksum.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}

export function matchingCounter(seed, code, now, previous = -1) {
  const timeCounter = Math.floor(now / 30_000);
  const value = Buffer.from(code);
  const counters = [timeCounter, timeCounter - 1, timeCounter + 1];
  const matched = counters.find((counter) => counter >= 0 &&
    timingSafeEqual(Buffer.from(totpAt(seed, counter)), value));
  return matched !== undefined && matched > previous ? matched : null;
}

export function generateRecoveryCodes() {
  return Array.from({ length: 8 }, () => randomBytes(20).toString('base64url'));
}
