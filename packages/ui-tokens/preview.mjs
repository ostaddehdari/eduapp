const jalaaliTime = new Intl.DateTimeFormat('fa-IR-u-ca-persian-nu-arabext', {
  timeZone: 'Asia/Tehran',
  dateStyle: 'long',
  timeStyle: 'short',
});
const utcTimestamp = /^([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2})(?:\.([0-9]{1,9}))?Z$/;

const schools = Object.freeze({
  aftab: Object.freeze({ name: 'مدرسهٔ آفتاب', updatedAt: '2026-03-20T21:00:00Z' }),
  baran: Object.freeze({ name: 'مدرسهٔ باران', updatedAt: '2026-03-23T05:15:00Z' }),
});

export const schoolOptions = Object.freeze([
  Object.freeze({ id: 'aftab', name: schools.aftab.name }),
  Object.freeze({ id: 'baran', name: schools.baran.name }),
]);

export function formatPersianTimestamp(timestamp) {
  if (typeof timestamp !== 'string') return null;
  const parts = utcTimestamp.exec(timestamp);
  if (!parts) return null;
  const [, seconds, fraction = ''] = parts;
  const isoMilliseconds = `${seconds}.${fraction.padEnd(3, '0').slice(0, 3)}Z`;
  const date = new Date(isoMilliseconds);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== isoMilliseconds) return null;
  return jalaaliTime.format(date);
}

export function readSchoolPreview(value) {
  const selection = value === undefined ? 'aftab' : value;
  if (typeof selection !== 'string' || !Object.hasOwn(schools, selection)) return null;
  return { id: selection, ...schools[selection] };
}
