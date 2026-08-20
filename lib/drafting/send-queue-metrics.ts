/**
 * Copy for send-queue counts. The board used to show 40/70 + reserved + sent
 * as if they were one ledger. They are not:
 *   taken (sent + queued) + held (auto leftover) + open = inbox slots that day.
 * Waiting (unsent cards on the board) is a different ledger.
 */

export function explainTakenSlots(input: {
  sent: number;
  queued: number;
  taken: number;
}): string {
  const listed = input.sent + input.queued;
  if (listed === input.taken) {
    return `${input.sent} sent + ${input.queued} still queued = ${input.taken} inbox slots taken. Held auto seats are separate and sit on top of this.`;
  }
  return `${input.taken} inbox slots are taken (sent + queued on these addresses). This view lists ${input.sent} sent and ${input.queued} queued — extra taken slots are mail not shown in the current filter.`;
}

export function explainHeldSlots(held: number, emailsPerDay?: number, alreadySlotted?: number): string {
  if (emailsPerDay != null && alreadySlotted != null) {
    return `This live auto campaign targets ${emailsPerDay}/day. ${alreadySlotted} already queued or sent, so ${held} inbox seat${held === 1 ? '' : 's'} ${held === 1 ? 'is' : 'are'} held so other mail cannot take them. Held is not an email card yet.`;
  }
  return `${held} inbox seat${held === 1 ? '' : 's'} held for live auto campaigns that have not filled their daily quota. Held = daily target minus already queued or sent. It is a seat, not a finished email.`;
}

export function explainOpenSlots(input: {
  inboxCount: number;
  capPerInbox: number;
  taken: number;
  held: number;
  open: number;
  capacity: number;
}): string {
  const inboxWord = input.inboxCount === 1 ? 'inbox' : 'inboxes';
  return `${input.inboxCount} ${inboxWord} × ${input.capPerInbox}/day = ${input.capacity} slots. ${input.taken} taken by sent + queued + ${input.held} held for auto campaigns. ${input.capacity} − ${input.taken} − ${input.held} = ${input.open} still open. Send now spends these open slots.`;
}

export function explainWaiting(input: {
  queued: number;
  sending: number;
  failed: number;
}): string {
  const parts = [
    input.queued > 0 ? `${input.queued} queued` : null,
    input.sending > 0 ? `${input.sending} sending` : null,
    input.failed > 0 ? `${input.failed} failed` : null,
  ].filter(Boolean);
  const total = input.queued + input.sending + input.failed;
  if (total === 0) {
    return 'No unsent mail on this board. Waiting is not the same as open inbox slots today.';
  }
  return `${parts.join(' + ')} = ${total} unsent on this board (any day). Waiting is email cards that have not gone out. It is not “how many slots are left today.”`;
}

export function explainSentToday(sent: number): string {
  if (sent === 0) {
    return 'Nothing has gone out yet today in America/New_York.';
  }
  return `${sent} email${sent === 1 ? '' : 's'} already sent today in America/New_York. Those slots are spent.`;
}

export function explainSentOnDay(sent: number, isToday: boolean): string {
  if (isToday) return explainSentToday(sent);
  if (sent === 0) return 'No emails sent on this day.';
  return `${sent} email${sent === 1 ? '' : 's'} sent on this day. Sent slots are spent.`;
}
