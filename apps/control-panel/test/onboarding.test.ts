import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  advanceDemo, canHaveBranch, initialState, persistDemo, readOnboardingState, restoreDemo, scopeKey, toAsciiDigits,
} from '../src/onboarding-model';

test('demo progress remains isolated and rejects mismatched steps', () => {
  const rows = new Map<string, string>();
  const storage = {
    getItem: (key: string) => rows.get(key) ?? null,
    setItem: (key: string, value: string) => { rows.set(key, value); },
    removeItem: (key: string) => { rows.delete(key); },
  };
  const first = advanceDemo(initialState(), {
    step: 'organization',
    input: { name: 'مجموعهٔ نمونه', code: 'demo', kind: 'collection' },
  });
  assert(persistDemo(storage, 'aftab', first));
  assert.deepEqual(restoreDemo(storage, 'aftab'), first);
  assert.deepEqual(restoreDemo(storage, 'baran'), initialState());
  rows.set(scopeKey('baran'), '{"version":2,"step":"site","draft":{}}');
  assert.deepEqual(restoreDemo(storage, 'baran'), initialState());
  assert.throws(() => advanceDemo(first, { step: 'site', input: { name: 'نمونه', slug: 'demo' } }),
    { message: 'ONBOARDING_STEP_MISMATCH' });
  assert.equal(canHaveBranch('company'), true);
  assert.equal(canHaveBranch('school'), false);
  assert.equal(toAsciiDigits('۱۲٣۴5۶'), '123456');
});

test('decode takes the known draft fields and strips unrecognized data', () => {
  const item = readOnboardingState({
    version: 1,
    step: 'school',
    draft: { organization: { name: 'نمونه', code: 'demo', kind: 'school', ignored: true }, unsupported: true },
  });
  assert.deepEqual(item, {
    version: 1, step: 'school', draft: { organization: { name: 'نمونه', code: 'demo', kind: 'school' } },
  });
});
