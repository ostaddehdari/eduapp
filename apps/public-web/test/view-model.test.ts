import assert from 'node:assert/strict';
import test from 'node:test';
import { pageTitle } from '../app/view-model';

test('public web uses a localized title', () => {
  assert.match(pageTitle, /مدیریت آموزشی/);
});
