// PURE local-time helpers. `now` is unix seconds UTC, `tzMin` the offset in minutes.

const DAY = 86400;
const mod = (a: number, n: number) => ((a % n) + n) % n;

export function localHour(now: number, tzMin: number): number {
  return Math.floor(mod(now + tzMin * 60, DAY) / 3600);
}

// 'YYYY-MM-DD' in local time.
export function localDate(now: number, tzMin: number): string {
  return new Date((now + tzMin * 60) * 1000).toISOString().slice(0, 10);
}

// 'HH:MM' in local time.
export function formatTime(now: number, tzMin: number): string {
  return new Date((now + tzMin * 60) * 1000).toISOString().slice(11, 16);
}

// 'HH:MM DD/MM' in local time.
export function formatDateTime(now: number, tzMin: number): string {
  const iso = new Date((now + tzMin * 60) * 1000).toISOString();
  return `${iso.slice(11, 16)} ${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
}

// Batches go out at even local hours from 08:00 to 22:00.
export function isBatchHour(now: number, tzMin: number): boolean {
  const h = localHour(now, tzMin);
  return h % 2 === 0 && h >= 8 && h <= 22;
}
