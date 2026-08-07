import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAILY_SEND_CAP,
  SEND_WINDOW_END_HOUR,
  SEND_WINDOW_START_HOUR,
  addCalendarDays,
  allocateOverflowSlots,
  formatNyDate,
  formatNyDateLabel,
  nyWallTimeToUtc,
  randomNySendTime,
  remainingCapacity,
} from '@/lib/drafting/send-queue-schedule';

function nyHour(date: Date): number {
  return Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hourCycle: 'h23',
    }).format(date),
  );
}

function nyDate(date: Date): string {
  return formatNyDate(date);
}

test('formatNyDateLabel renders month and day', () => {
  assert.equal(formatNyDateLabel('2026-08-12'), 'Aug 12');
});

test('addCalendarDays rolls months', () => {
  assert.equal(addCalendarDays('2026-08-31', 1), '2026-09-01');
  assert.equal(addCalendarDays('2026-12-31', 1), '2027-01-01');
});

test('nyWallTimeToUtc lands on the intended NY wall clock', () => {
  const noon = nyWallTimeToUtc('2026-08-12', 12, 0);
  assert.equal(nyDate(noon), '2026-08-12');
  assert.equal(nyHour(noon), 12);

  // EDT (UTC-4) in August
  assert.equal(noon.toISOString(), '2026-08-12T16:00:00.000Z');
});

test('randomNySendTime stays inside 9–5 NY', () => {
  let seq = 0;
  const rng = () => {
    const values = [0, 0.25, 0.5, 0.75, 0.9999];
    return values[seq++ % values.length]!;
  };
  for (let i = 0; i < 5; i += 1) {
    const t = randomNySendTime('2026-08-12', rng);
    assert.equal(nyDate(t), '2026-08-12');
    const hour = nyHour(t);
    assert.ok(hour >= SEND_WINDOW_START_HOUR && hour < SEND_WINDOW_END_HOUR);
  }
});

test('allocateOverflowSlots skips today and fills future days to cap', () => {
  const usage = new Map<string, number>([['2026-08-07', 18]]);
  const slots = allocateOverflowSlots({
    count: 5,
    dayUsage: usage,
    todayNy: '2026-08-06',
    rng: () => 0.1,
  });
  assert.equal(slots.length, 5);
  assert.ok(slots.every((s) => s.scheduleDate >= '2026-08-07'));
  // Day with 18 used has 2 free → first 2 land there
  assert.equal(slots.filter((s) => s.scheduleDate === '2026-08-07').length, 2);
  assert.equal(slots.filter((s) => s.scheduleDate === '2026-08-08').length, 3);
});

test('allocateOverflowSlots walks past full days', () => {
  const usage = new Map<string, number>([
    ['2026-08-07', DAILY_SEND_CAP],
    ['2026-08-08', DAILY_SEND_CAP],
  ]);
  const slots = allocateOverflowSlots({
    count: 2,
    dayUsage: usage,
    todayNy: '2026-08-06',
    rng: () => 0.2,
  });
  assert.deepEqual(slots.map((s) => s.scheduleDate), ['2026-08-09', '2026-08-09']);
});

test('remainingCapacity clamps at zero', () => {
  assert.equal(remainingCapacity(0), 20);
  assert.equal(remainingCapacity(15), 5);
  assert.equal(remainingCapacity(20), 0);
  assert.equal(remainingCapacity(25), 0);
});
