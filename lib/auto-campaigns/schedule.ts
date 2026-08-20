import {
  addCalendarDays,
  formatNyDate,
  nyWallTimeToUtc,
} from '@/lib/drafting/send-queue-schedule';

export const AUTO_CYCLE_WINDOW_START_HOUR = 2;
export const AUTO_CYCLE_WINDOW_END_HOUR = 6;
export const THIN_DAYS_BEFORE_EXHAUST = 2;

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function nyWeekdayIndex(date: Date = new Date()): number {
  const label = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
  }).format(date);
  const index = WEEKDAY_SHORT.indexOf(label as (typeof WEEKDAY_SHORT)[number]);
  return index < 0 ? date.getUTCDay() : index;
}

export function isNyWeekday(date: Date = new Date()): boolean {
  const day = nyWeekdayIndex(date);
  return day >= 1 && day <= 5;
}

/** Stable minute-of-day in [02:00, 06:00) America/New_York. */
export function staggerMinuteOfDay(campaignId: string): number {
  let hash = 0;
  for (let i = 0; i < campaignId.length; i += 1) {
    hash = (hash * 33 + campaignId.charCodeAt(i)) >>> 0;
  }
  const span = (AUTO_CYCLE_WINDOW_END_HOUR - AUTO_CYCLE_WINDOW_START_HOUR) * 60;
  return AUTO_CYCLE_WINDOW_START_HOUR * 60 + (hash % span);
}

export function nextWeekdayNyDate(fromNyDate: string): string {
  let cursor = fromNyDate;
  for (let i = 0; i < 8; i += 1) {
    const noonUtc = nyWallTimeToUtc(cursor, 12, 0);
    if (isNyWeekday(noonUtc)) return cursor;
    cursor = addCalendarDays(cursor, 1);
  }
  return cursor;
}

export function nextAutoCycleAt(campaignId: string, after: Date = new Date()): Date {
  const minute = staggerMinuteOfDay(campaignId);
  const hour = Math.floor(minute / 60);
  const min = minute % 60;
  let nyDate = formatNyDate(after);
  const todaySlot = nyWallTimeToUtc(nyDate, hour, min);
  if (!isNyWeekday(after) || todaySlot.getTime() <= after.getTime()) {
    nyDate = addCalendarDays(nyDate, 1);
  }
  nyDate = nextWeekdayNyDate(nyDate);
  return nyWallTimeToUtc(nyDate, hour, min);
}

export function shouldRunFirstCycleNow(now: Date = new Date()): boolean {
  return isNyWeekday(now);
}

/** After a cycle has already run today, always schedule the next weekday window. */
export function nextAutoCycleAfterCompletion(campaignId: string, after: Date = new Date()): Date {
  const tomorrow = addCalendarDays(formatNyDate(after), 1);
  const minute = staggerMinuteOfDay(campaignId);
  const hour = Math.floor(minute / 60);
  const min = minute % 60;
  return nyWallTimeToUtc(nextWeekdayNyDate(tomorrow), hour, min);
}
