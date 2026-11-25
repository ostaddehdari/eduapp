import assert from 'node:assert/strict';

export function localFixtureUrl(value, protocols) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError('Use a valid disposable service URL');
  }
  assert.ok(protocols.includes(url.protocol), 'Use a supported fixture protocol');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname), 'Use a loopback fixture service');
  assert.ok(!url.search && !url.hash, 'Omit URL query options and fragments');
  return url;
}
