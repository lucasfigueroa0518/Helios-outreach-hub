/**
 * Pure America/New_York day-budget + random 9–5 slot helpers for the send queue.
 * No DB / network — safe for unit tests.
 */

export const SEND_QUEUE_TIMEZONE = 'America/New_York';
export const DAILY_SEND_CAP = 20;
export const SEND_WINDOW_START_HOUR = 9;
export const SEND_WINDOW_END_HOUR = 17;
export const SEND_SLOT_MIN_GAP_MS = 120_000;

export type OverflowSlot = {
  scheduleDate: string;
  scheduledFor: Date;
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** Calendar date YYYY-MM-DD in America/New_York for an instant. */
export function formatNyDate(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SEND_QUEUE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** User-facing label like "Aug 12" for a YYYY-MM-DD calendar date. */
export function formatNyDateLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  if (!y || !m || !d) return dateStr;
  const utc = new Date(Date.UTC(y, m - 1, d, 12));
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(utc);
}

export function addCalendarDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const utc = new Date(Date.UTC(y, m - 1, d));
  utc.setUTCDate(utc.getUTCDate() + days);
  return `${utc.getUTCFullYear()}-${pad2(utc.getUTCMonth() + 1)}-${pad2(utc.getUTCDate())}`;
}

function nyParts(date: Date): { dateStr: string; hour: number; minute: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: SEND_QUEUE_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return {
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function calendarDayDiff(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ty, tm, td] = to.split('-').map(Number);
  const a = Date.UTC(fy, fm - 1, fd);
  const b = Date.UTC(ty, tm - 1, td);
  return Math.round((b - a) / 86_400_000);
}

/** Convert NY wall-clock on a calendar date to a UTC Date. */
export function nyWallTimeToUtc(dateStr: string, hour: number, minute: number): Date {
  const [y, m, d] = dateStr.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, hour + 5, minute, 0);
  for (let i = 0; i < 6; i += 1) {
    const parts = nyParts(new Date(guess));
    const asMinutes = parts.hour * 60 + parts.minute;
    const targetMinutes = hour * 60 + minute;
    const dayOffset = calendarDayDiff(parts.dateStr, dateStr);
    const deltaMin = dayOffset * 24 * 60 + (targetMinutes - asMinutes);
    if (deltaMin === 0) break;
    guess += deltaMin * 60_000;
  }
  return new Date(guess);
}

/** Uniform random minute in [09:00, 17:00) America/New_York. */
export function randomNySendTime(dateStr: string, rng: () => number = Math.random): Date {
  const start = SEND_WINDOW_START_HOUR * 60;
  const end = SEND_WINDOW_END_HOUR * 60;
  const span = end - start;
  const minuteOfDay = start + Math.floor(rng() * span);
  return nyWallTimeToUtc(dateStr, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
}

function spacedRandomTime(
  dateStr: string,
  existing: Date[],
  rng: () => number,
): Date {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const candidate = randomNySendTime(dateStr, rng);
    if (existing.every((t) => Math.abs(t.getTime() - candidate.getTime()) >= SEND_SLOT_MIN_GAP_MS)) {
      return candidate;
    }
  }
  // Fallback: bump past the latest existing time within the window.
  const sorted = [...existing].sort((a, b) => a.getTime() - b.getTime());
  const last = sorted[sorted.length - 1];
  const bumped = new Date(last.getTime() + SEND_SLOT_MIN_GAP_MS);
  const windowEnd = nyWallTimeToUtc(dateStr, SEND_WINDOW_END_HOUR, 0);
  if (bumped < windowEnd) return bumped;
  return randomNySendTime(dateStr, rng);
}

/**
 * Allocate `count` overflow slots starting from the day after `todayNy`,
 * filling each day up to `cap` and assigning random 9–5 NY times.
 */
export function allocateOverflowSlots(input: {
  count: number;
  dayUsage: Map<string, number>;
  todayNy: string;
  cap?: number;
  rng?: () => number;
}): OverflowSlot[] {
  const cap = input.cap ?? DAILY_SEND_CAP;
  const rng = input.rng ?? Math.random;
  const usage = new Map(input.dayUsage);
  const results: OverflowSlot[] = [];
  const timesByDay = new Map<string, Date[]>();

  let day = addCalendarDays(input.todayNy, 1);
  for (let i = 0; i < input.count; i += 1) {
    while ((usage.get(day) ?? 0) >= cap) {
      day = addCalendarDays(day, 1);
    }
    const existing = timesByDay.get(day) ?? [];
    const scheduledFor = spacedRandomTime(day, existing, rng);
    existing.push(scheduledFor);
    timesByDay.set(day, existing);
    usage.set(day, (usage.get(day) ?? 0) + 1);
    results.push({ scheduleDate: day, scheduledFor });
  }
  return results;
}

/** Remaining slots for a day given current usage. */
export function remainingCapacity(used: number, cap = DAILY_SEND_CAP): number {
  return Math.max(0, cap - Math.max(0, used));
}
