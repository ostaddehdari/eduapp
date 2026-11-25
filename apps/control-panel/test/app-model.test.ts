import assert from 'node:assert/strict';
import test from 'node:test';
import { welcomeTitle } from '../src/app-model';

test('control panel trims a school name and rejects an empty name', () => {
  assert.equal(welcomeTitle('  مدرسه نمونه  '), 'خوش آمدید، مدرسه نمونه');
  assert.throws(() => welcomeTitle(' '), /TENANT_NAME_REQUIRED/);
});
