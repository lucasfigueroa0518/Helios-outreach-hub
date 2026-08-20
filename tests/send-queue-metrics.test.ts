import assert from 'node:assert/strict';
import test from 'node:test';

import {
  explainHeldSlots,
  explainOpenSlots,
  explainTakenSlots,
  explainWaiting,
} from '@/lib/drafting/send-queue-metrics';

test('open slots copy is taken + held + open = capacity', () => {
  const tip = explainOpenSlots({
    inboxCount: 7,
    capPerInbox: 10,
    taken: 40,
    held: 1,
    open: 29,
    capacity: 70,
  });
  assert.match(tip, /7 inboxes × 10\/day = 70 slots/);
  assert.match(tip, /70 − 40 − 1 = 29/);
});

test('taken slots call out when the listed cards do not add up', () => {
  const aligned = explainTakenSlots({ sent: 32, queued: 8, taken: 40 });
  assert.match(aligned, /32 sent \+ 8 still queued = 40/);
  const filtered = explainTakenSlots({ sent: 12, queued: 0, taken: 40 });
  assert.match(filtered, /not shown in the current filter/);
});

test('waiting is unsent cards, not open slots', () => {
  const tip = explainWaiting({ queued: 40, sending: 0, failed: 2 });
  assert.match(tip, /40 queued \+ 2 failed = 42/);
  assert.match(tip, /not “how many slots are left today.”/);
});

test('held seats are leftover auto quota, not sent mail', () => {
  const tip = explainHeldSlots(1, 50, 49);
  assert.match(tip, /targets 50\/day/);
  assert.match(tip, /49 already queued or sent/);
});
