import assert from 'node:assert/strict';
import test from 'node:test';

import { REPLY_CALENDLY_URL, REPLY_WEBSITE_VISIBLE } from '@/lib/drafting/reply-constants';
import { resolveDeferUntil, formatDateOnly } from '@/lib/drafting/reply-defer';
import { isAutomaticReply } from '@/lib/drafting/reply-inbound';
import { linkifyReplyPlainFragment, replyPlainTextBodyToHtml } from '@/lib/drafting/reply-linkify';
import { lintReplyBody } from '@/lib/drafting/reply-lint';

test('lintReplyBody requires calendly for reply_now and bans em dashes', () => {
  const ok = lintReplyBody(`Sounds good.\n\nBook here: ${REPLY_CALENDLY_URL}`);
  assert.equal(ok.length, 0);

  const missing = lintReplyBody('Sounds good. Talk soon.');
  assert.ok(missing.some((f) => f.code === 'MISSING_CALENDLY'));

  const dash = lintReplyBody(`Quick note — book: ${REPLY_CALENDLY_URL}`);
  assert.ok(dash.some((f) => f.code === 'EM_DASH'));
});

test('lintReplyBody forbids calendly on defer and suppress', () => {
  const deferOk = lintReplyBody('Got it. I will check back mid-month.', {
    disposition: 'defer',
    includeCalendly: false,
  });
  assert.equal(deferOk.length, 0);

  const deferBad = lintReplyBody(`Got it.\n\n${REPLY_CALENDLY_URL}`, {
    disposition: 'defer',
    includeCalendly: false,
  });
  assert.ok(deferBad.some((f) => f.code === 'CALENDLY_FORBIDDEN'));

  const suppressOk = lintReplyBody('Understood. I will not email again.', {
    disposition: 'suppress',
    includeCalendly: false,
  });
  assert.equal(suppressOk.length, 0);
});

test('lintReplyBody requires heliosgroup.ai when website tool used', () => {
  const findings = lintReplyBody(
    `More on our site.\n\n${REPLY_CALENDLY_URL}`,
    { websiteToolUsed: true },
  );
  assert.ok(findings.some((f) => f.code === 'WEBSITE_ANCHOR'));

  const ok = lintReplyBody(
    `More at ${REPLY_WEBSITE_VISIBLE}.\n\n${REPLY_CALENDLY_URL}`,
    { websiteToolUsed: true },
  );
  assert.equal(ok.length, 0);
});

test('reply linkify hyperlinks calendly and bare heliosgroup.ai', () => {
  const html = replyPlainTextBodyToHtml(
    `See ${REPLY_WEBSITE_VISIBLE} then book ${REPLY_CALENDLY_URL}`,
  );
  assert.match(html, /href="https:\/\/heliosgroup\.ai"/);
  assert.match(html, />heliosgroup\.ai</);
  assert.match(html, new RegExp(`href="${REPLY_CALENDLY_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.equal(
    linkifyReplyPlainFragment(REPLY_WEBSITE_VISIBLE).includes('href="https://heliosgroup.ai"'),
    true,
  );
});

test('isAutomaticReply detects OOO / bulk headers', () => {
  assert.equal(isAutomaticReply({}, 'lead@example.com'), null);
  assert.equal(
    isAutomaticReply({ 'auto-submitted': 'auto-replied' }, 'lead@example.com'),
    'auto_submitted:auto-replied',
  );
  assert.equal(
    isAutomaticReply({ precedence: 'bulk' }, 'lead@example.com'),
    'precedence:bulk',
  );
  assert.equal(
    isAutomaticReply({}, 'mailer-daemon@example.com'),
    'mailer_daemon',
  );
});

test('resolveDeferUntil parses common phrases', () => {
  const now = new Date('2026-08-08T12:00:00.000Z');

  const iso = resolveDeferUntil({
    explicitIso: '2026-09-01',
    leadText: 'later',
    now,
  });
  assert.equal(iso.deferUntil, '2026-09-01');
  assert.equal(iso.source, 'explicit_iso');

  const mid = resolveDeferUntil({
    leadText: 'ping me mid month',
    now,
  });
  assert.equal(mid.deferUntil, '2026-08-15');
  assert.equal(mid.label, 'mid_month');

  const day = resolveDeferUntil({
    leadText: 'reach out on the 20th',
    now,
  });
  assert.equal(day.deferUntil, '2026-08-20');

  const nextWeek = resolveDeferUntil({
    leadText: 'maybe next week',
    now,
  });
  assert.equal(nextWeek.deferUntil, formatDateOnly(new Date('2026-08-15T00:00:00.000Z')));
});

test('reply plus-address remains the outbound Reply-To helper', async () => {
  const { replyToAddressForItem } = await import('@/lib/drafting/send');
  const original = process.env.RESEND_REPLY_DOMAIN;
  try {
    process.env.RESEND_REPLY_DOMAIN = 'replies.heliosgroup.ai';
    const itemId = '4755aa7b-cee3-4794-bf73-143cb3fabd06';
    assert.equal(
      replyToAddressForItem(itemId),
      `reply+${itemId}@replies.heliosgroup.ai`,
    );
  } finally {
    if (original === undefined) delete process.env.RESEND_REPLY_DOMAIN;
    else process.env.RESEND_REPLY_DOMAIN = original;
  }
});
