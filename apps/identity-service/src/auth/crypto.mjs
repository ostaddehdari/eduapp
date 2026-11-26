import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const PASSWORD_FORMAT = 'scrypt-v1';
const PASSWORD_OPTIONS = { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const scryptAsync = promisify(scrypt);
const HEX = /^[0-9a-f]+$/;
const JWT_HEADER = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');

export function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function privateFingerprint(pepper, ...values) {
  return createHmac('sha256', pepper).update(JSON.stringify(values)).digest('hex');
}

export function equalHex(left, right) {
  return typeof left === 'string' && typeof right === 'string' && left.length === right.length &&
    left.length % 2 === 0 && HEX.test(left) && HEX.test(right) &&
    timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

export function isPasswordInput(password) {
  return typeof password === 'string' && password.length > 0 && Buffer.byteLength(password) <= 1024;
}

export async function hashPassword(password) {
  if (!isPasswordInput(password)) throw new TypeError('Invalid password input');
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 32, PASSWORD_OPTIONS);
  return [PASSWORD_FORMAT, salt.toString('hex'), hash.toString('hex')].join('$');
}

export async function verifyPassword(password, storedHash) {
  const candidate = typeof storedHash === 'string'
    ? /^scrypt-v1\$([0-9a-f]{32})\$([0-9a-f]{64})$/.exec(storedHash)
    : null;
  const salt = candidate ? Buffer.from(candidate[1], 'hex') : Buffer.alloc(16);
  const derived = await scryptAsync(password, salt, 32, PASSWORD_OPTIONS);
  return candidate !== null && equalHex(derived.toString('hex'), candidate[2]);
}

export function issueAccessToken(key, now, expiresAt) {
  const encoded = Buffer.from(JSON.stringify({
    iss: 'eduapp-iam',
    aud: 'eduapp-api',
    iat: Math.floor(now / 1000),
    exp: Math.floor(expiresAt / 1000),
    jti: randomBytes(24).toString('base64url'),
  })).toString('base64url');
  const message = `${JWT_HEADER}.${encoded}`;
  return `${message}.${createHmac('sha256', key).update(message).digest('base64url')}`;
}

export function isCurrentAccessToken(token, key, now) {
  if (typeof token !== 'string' || token.length > 1024) return false;
  const [header, payload, signature, ...extra] = token.split('.');
  if (extra.length || header !== JWT_HEADER || !/^[A-Za-z0-9_-]+$/.test(payload ?? '') ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature ?? '')) return false;
  const expected = createHmac('sha256', key).update(`${header}.${payload}`).digest('base64url');
  if (!timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return false;
  let claims;
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); }
  catch { return false; }
  const nowSeconds = Math.floor(now / 1000);
  return claims?.iss === 'eduapp-iam' && claims.aud === 'eduapp-api' &&
    Number.isSafeInteger(claims.iat) && claims.iat <= nowSeconds &&
    Number.isSafeInteger(claims.exp) && claims.exp > nowSeconds;
}

export function issueRefreshToken(sessionId) {
  return `${sessionId}.${randomBytes(32).toString('base64url')}`;
}

export function parseRefreshToken(token) {
  if (typeof token !== 'string' || token.length !== 80) return null;
  const [sessionId, entropy] = token.split('.');
  return UUID.test(sessionId) && /^[A-Za-z0-9_-]{43}$/.test(entropy ?? '') ? sessionId : null;
}
