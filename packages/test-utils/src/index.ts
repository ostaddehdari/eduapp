export function testClock(iso: string): Date {
  const time = new Date(iso);
  if (Number.isNaN(time.valueOf())) throw new Error('Invalid test clock');
  return time;
}
