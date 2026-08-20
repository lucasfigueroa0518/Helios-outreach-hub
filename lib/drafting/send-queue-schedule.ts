/**
 * Pure America/New_York day-budget + random 9–5 slot helpers for the send queue.
 * No DB / network — safe for unit tests.
 */

export const SEND_QUEUE_TIMEZONE = 'America/New_York';
/** @deprecated Per-user cap. Outreach now uses per-inbox cap from org_settings (10|20). */
export const DAILY_SEND_CAP = 10;
export const SEND_WINDOW_START_HOUR = 9;
export const SEND_WINDOW_END_HOUR = 17;
export const SEND_SLOT_MIN_GAP_MS = 120_000;
/** Live queue board: today through this many days ahead. */
export const SEND_QUEUE_LIVE_HORIZON_DAYS = 14;
/** Extra calendar days before today, so the board can scroll back one week. */
export const SEND_QUEUE_LOOKBACK_DAYS = 7;

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

/**
 * Queue board date window: prior 7 NY days through today + 14.
 * The UI starts scrolled to today so last week is reachable by scrolling left.
 */
export function sendQueueBoardWindow(today: string): { from: string; to: string } {
  return {
    from: addCalendarDays(today, -SEND_QUEUE_LOOKBACK_DAYS),
    to: addCalendarDays(today, SEND_QUEUE_LIVE_HORIZON_DAYS),
  };
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
  return allocatePackedSlots({
    count: input.count,
    dayUsage: input.dayUsage,
    startNy: addCalendarDays(input.todayNy, 1),
    cap: input.cap,
    rng: input.rng,
  });
}

/**
 * Pack `count` slots starting at `startNy` (often today), filling each day up
 * to `cap` with random 9–5 NY times. Used after queue share to push work ASAP.
 */
export function allocatePackedSlots(input: {
  count: number;
  dayUsage: Map<string, number>;
  startNy: string;
  cap?: number;
  rng?: () => number;
}): OverflowSlot[] {
  const cap = input.cap ?? DAILY_SEND_CAP;
  const rng = input.rng ?? Math.random;
  const usage = new Map(input.dayUsage);
  const results: OverflowSlot[] = [];
  const timesByDay = new Map<string, Date[]>();

  let day = input.startNy;
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

/**
 * How many backlog items the sharer should transfer so both end near equal.
 * Returns 0 when the sharer does not have a larger backlog.
 */
export function computeShareTransferCount(
  sharerBacklog: number,
  recipientBacklog: number,
): number {
  if (sharerBacklog <= 0 || sharerBacklog <= recipientBacklog) return 0;
  const total = sharerBacklog + recipientBacklog;
  const targetEach = Math.floor(total / 2);
  return Math.max(0, sharerBacklog - targetEach);
}

/** Remaining slots for a day given current usage. */
export function remainingCapacity(used: number, cap = DAILY_SEND_CAP): number {
  return Math.max(0, cap - Math.max(0, used));
}

export type InboxSlot = OverflowSlot & {
  inboxId: string;
  email: string;
};

export type InboxDayUsage = Map<string, number>;

function inboxDayKey(inboxId: string, date: string): string {
  return `${inboxId}:${date}`;
}

/**
 * Fill each inbox to `cap` on a day (sort order), then advance to the next day.
 */
export function allocateInboxSlots(input: {
  count: number;
  inboxes: Array<{ id: string; email: string }>;
  usage: InboxDayUsage;
  startNy: string;
  cap: number;
  rng?: () => number;
}): InboxSlot[] {
  if (input.inboxes.length === 0 || input.count <= 0) return [];
  const rng = input.rng ?? Math.random;
  const usage = new Map(input.usage);
  const results: InboxSlot[] = [];
  const timesByKey = new Map<string, Date[]>();

  let day = input.startNy;
  let guard = 0;
  while (results.length < input.count && guard < 10_000) {
    guard += 1;
    let filledAny = false;
    for (const inbox of input.inboxes) {
      while (results.length < input.count) {
        const key = inboxDayKey(inbox.id, day);
        if ((usage.get(key) ?? 0) >= input.cap) break;
        const existing = timesByKey.get(key) ?? [];
        const scheduledFor = spacedRandomTime(day, existing, rng);
        existing.push(scheduledFor);
        timesByKey.set(key, existing);
        usage.set(key, (usage.get(key) ?? 0) + 1);
        results.push({
          inboxId: inbox.id,
          email: inbox.email,
          scheduleDate: day,
          scheduledFor,
        });
        filledAny = true;
      }
    }
    if (!filledAny) day = addCalendarDays(day, 1);
  }
  return results;
}

export function inboxUsageKey(inboxId: string, date: string): string {
  return inboxDayKey(inboxId, date);
}

/** After 5pm NY, new allocations start tomorrow so today columns do not go overdue. */
export function allocationStartNy(now = new Date()): string {
  const today = formatNyDate(now);
  const hour = nyParts(now).hour;
  if (hour >= SEND_WINDOW_END_HOUR) return addCalendarDays(today, 1);
  return today;
}
