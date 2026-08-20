import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DAILY_SEND_CAP,
  SEND_WINDOW_END_HOUR,
  SEND_WINDOW_START_HOUR,
  addCalendarDays,
  allocateInboxSlots,
  allocateOverflowSlots,
  allocatePackedSlots,
  computeShareTransferCount,
  formatNyDate,
  formatNyDateLabel,
  inboxUsageKey,
  nyWallTimeToUtc,
  randomNySendTime,
  remainingCapacity,
  sendQueueBoardWindow,
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

test('sendQueueBoardWindow includes the prior week and two-week lookahead', () => {
  assert.deepEqual(sendQueueBoardWindow('2026-08-20'), {
    from: '2026-08-13',
    to: '2026-09-03',
  });
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
    cap: 20,
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
    ['2026-08-07', 20],
    ['2026-08-08', 20],
  ]);
  const slots = allocateOverflowSlots({
    count: 2,
    dayUsage: usage,
    todayNy: '2026-08-06',
    cap: 20,
    rng: () => 0.2,
  });
  assert.deepEqual(slots.map((s) => s.scheduleDate), ['2026-08-09', '2026-08-09']);
});

test('remainingCapacity clamps at zero', () => {
  assert.equal(remainingCapacity(0, 10), 10);
  assert.equal(remainingCapacity(7, 10), 3);
  assert.equal(remainingCapacity(10, 10), 0);
  assert.equal(remainingCapacity(25, 10), 0);
});

test('allocatePackedSlots can start today', () => {
  const usage = new Map<string, number>([['2026-08-10', 18]]);
  const slots = allocatePackedSlots({
    count: 4,
    dayUsage: usage,
    startNy: '2026-08-10',
    cap: 20,
    rng: () => 0.1,
  });
  assert.equal(slots.filter((s) => s.scheduleDate === '2026-08-10').length, 2);
  assert.equal(slots.filter((s) => s.scheduleDate === '2026-08-11').length, 2);
});

test('allocateInboxSlots fills every address to cap before the next day', () => {
  const inboxes = [
    { id: 'lucas-1', email: 'lucas@heliosgroup.email' },
    { id: 'lucas-2', email: 'lucas@heliosgroup.online' },
    { id: 'lucas-3', email: 'l.figueroa@heliosgroup.email' },
    { id: 'lucas-4', email: 'lfigueroa@heliosgroup.email' },
  ];
  const slots = allocateInboxSlots({
    count: 14,
    inboxes,
    usage: new Map(),
    startNy: '2026-08-19',
    cap: 10,
    rng: () => 0.1,
  });
  assert.equal(slots.length, 14);
  assert.ok(slots.every((s) => s.scheduleDate === '2026-08-19'));
  assert.equal(slots.filter((s) => s.email === 'lucas@heliosgroup.email').length, 10);
  assert.equal(slots.filter((s) => s.email === 'lucas@heliosgroup.online').length, 4);
});

test('allocateInboxSlots fills each address for day one then day two', () => {
  const inboxes = [
    { id: 'lucas-1', email: 'lucas@heliosgroup.email' },
    { id: 'lucas-2', email: 'lucas@heliosgroup.online' },
    { id: 'lucas-3', email: 'l.figueroa@heliosgroup.email' },
    { id: 'lucas-4', email: 'lfigueroa@heliosgroup.email' },
  ];
  const slots = allocateInboxSlots({
    count: 90,
    inboxes,
    usage: new Map(),
    startNy: '2026-08-15',
    cap: 10,
    rng: () => 0.1,
  });
  assert.equal(slots.length, 90);
  const day1 = slots.filter((s) => s.scheduleDate === '2026-08-15');
  const day2 = slots.filter((s) => s.scheduleDate === '2026-08-16');
  const day3 = slots.filter((s) => s.scheduleDate === '2026-08-17');
  assert.equal(day1.length, 40);
  assert.equal(day2.length, 40);
  assert.equal(day3.length, 10);
  assert.ok(day1.every((s) => inboxes.some((i) => i.id === s.inboxId)));
  assert.equal(day1.filter((s) => s.email === 'lucas@heliosgroup.email').length, 10);
  assert.equal(day3.every((s) => s.email === 'lucas@heliosgroup.email'), true);
});

test('allocateInboxSlots respects existing inbox usage', () => {
  const inboxes = [
    { id: 'a', email: 'lucas@heliosgroup.email' },
    { id: 'b', email: 'lucas@heliosgroup.online' },
  ];
  const usage = new Map<string, number>([[inboxUsageKey('a', '2026-08-15'), 8]]);
  const slots = allocateInboxSlots({
    count: 5,
    inboxes,
    usage,
    startNy: '2026-08-15',
    cap: 10,
    rng: () => 0.2,
  });
  assert.equal(slots.filter((s) => s.inboxId === 'a' && s.scheduleDate === '2026-08-15').length, 2);
  assert.equal(slots.filter((s) => s.inboxId === 'b' && s.scheduleDate === '2026-08-15').length, 3);
});

test('computeShareTransferCount equalizes backlog', () => {
  assert.equal(computeShareTransferCount(100, 0), 50);
  assert.equal(computeShareTransferCount(60, 20), 20);
  assert.equal(computeShareTransferCount(20, 60), 0);
  assert.equal(computeShareTransferCount(0, 0), 0);
  assert.equal(computeShareTransferCount(5, 5), 0);
  assert.equal(computeShareTransferCount(41, 20), 11); // 61 total → 30/31
});
