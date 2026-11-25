import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatPersianTimestamp, readSchoolPreview } from '../../packages/ui-tokens/preview.mjs';

test('displays the Iranian date after UTC crosses the local midnight', () => {
  assert.match(formatPersianTimestamp('2026-03-20T20:29:59.123456Z'), /۲۹ اسفند ۱۴۰۴/);
  assert.match(formatPersianTimestamp('2026-03-20T20:30:00.000Z'), /۱ فروردین ۱۴۰۵/);
});

test('invalid and noncanonical timestamps have no display value', () => {
  for (const input of [null, '', '2026-02-30T12:00:00Z', '2026-03-20T24:00:00Z',
    '2026-03-20T12:00:00', '2026-03-20T12:00:00+03:30', '1405-01-01', 'private']) {
    assert.equal(formatPersianTimestamp(input), null);
  }
});

test('sample school selection stays local, rejects ambiguous values and keeps UTC intact', () => {
  const defaultSchool = readSchoolPreview(undefined);
  const other = readSchoolPreview('baran');
  assert.equal(defaultSchool.name, 'مدرسهٔ آفتاب');
  assert.equal(other.name, 'مدرسهٔ باران');
  assert.equal(defaultSchool.updatedAt, '2026-03-20T21:00:00Z');
  assert.notEqual(formatPersianTimestamp(defaultSchool.updatedAt), formatPersianTimestamp(other.updatedAt));
  for (const input of ['unknown', 'constructor', 'toString', [], ['aftab', 'baran'], '', null]) {
    assert.equal(readSchoolPreview(input), null);
  }
});
