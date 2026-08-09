/**
 * Round-2 local simulation: lead replies again to our calendly auto-response.
 * Stores second inbound on the same threads, drafts a follow-up via the reply
 * writer (full thread in context), never calls Resend.
 *
 * Usage: npx tsx scripts/simulate_reply_round2.ts [path-to-round1-json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const root = path.join(__dirname, '..');
const envPath = path.join(root, '.env.local');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match) {
      process.env[match[1]] = match[2].replace(/^["']|["']$/g, '');
    }
  }
}

import { dbQuery } from '@/lib/db';
import { normalizeDraftText } from '@/lib/drafting/normalize';
import { lintReplyBody } from '@/lib/drafting/reply-lint';
import { runReplyWrite } from '@/lib/drafting/reply-provider';
import { getDraftingMode } from '@/lib/models';

type Round1Result = {
  index: number;
  label: string;
  tone: string;
  lead: string | null;
  company: string | null;
  campaign?: string;
  outboundSubject: string;
  inbound: string;
  autoReplySubject: string;
  autoReplyBody: string;
  emailSendId: string;
  conversationsUrl?: string;
};

/** Second-round lead replies — reacting to our calendly nudge. Same blunt style. */
const ROUND2_REPLIES: Array<{ label: string; tone: string; body: string }> = [
  { label: 'still-dismissive', tone: 'dismissive', body: 'k' },
  { label: 'still-no', tone: 'busy', body: 'still no' },
  { label: 'how-long', tone: 'guarded', body: 'ok whatever. how long is the call' },
  { label: 'no-calendly', tone: 'pushback', body: 'dont use calendly. just email me 2 times that work' },
  { label: 'wont-share-ops', tone: 'deflecting', body: 'im not giving you their email. figure it out' },
  { label: 'ballpark-or-out', tone: 'transactional', body: 'ballpark it or im out. not hopping on a call for a mystery number' },
  { label: 'case-study-ask', tone: 'skeptical', body: 'still sounds the same. send a case study. short' },
  { label: 'grudging-book', tone: 'lukewarm', body: 'lol ok. thursday morning if you have anything' },
  { label: 'one-word-again', tone: 'dismissive', body: 'ya' },
  { label: 'soft-confirm', tone: 'respectful-interest', body: 'Booked something for Tuesday. Talk then.' },
  { label: 'proof-ask', tone: 'curious', body: 'looked at the site. still vague. who have you actually done this for' },
  { label: 'hard-stop-again', tone: 'hard-no', body: 'i said stop. remove me from whatever list this is' },
  { label: 'short-yes-terms', tone: 'guarded', body: 'fine. 15 min max. dont pitch' },
  { label: 'date-ok', tone: 'respectful-busy', body: 'ok put something on for the 20th if you still want' },
  { label: 'threat-hangup', tone: 'mixed', body: 'sent. if this is a sales call im hanging up in 2 minutes' },
];

async function loadOutboundContext(emailSendId: string): Promise<{
  drafting_item_id: string;
  owner_id: string;
  campaign_id: string;
  from_email: string;
  to_email: string;
  subject: string;
  body: string | null;
  lead_name: string | null;
  lead_company: string | null;
} | null> {
  const { rows } = await dbQuery<{
    drafting_item_id: string;
    owner_id: string;
    campaign_id: string;
    from_email: string;
    to_email: string;
    subject: string;
    body: string | null;
    lead_name: string | null;
    lead_company: string | null;
  }>(
    `SELECT s.drafting_item_id::text,
            c.owner_id::text AS owner_id,
            w.campaign_id::text AS campaign_id,
            s.from_email,
            s.to_email,
            s.subject,
            d.body_text AS body,
            coalesce(
              nullif(trim(i.input_snapshot #>> '{lead,fullName}'), ''),
              nullif(trim(i.input_snapshot #>> '{lead,firstName}'), '')
            ) AS lead_name,
            nullif(trim(i.input_snapshot #>> '{lead,company}'), '') AS lead_company
       FROM outreach.email_sends s
       JOIN outreach.drafting_items i ON i.id = s.drafting_item_id
       JOIN outreach.drafting_workspaces w ON w.id = i.workspace_id
       JOIN outreach.campaigns c ON c.id = w.campaign_id
       LEFT JOIN LATERAL (
         SELECT body_text
           FROM outreach.email_drafts
          WHERE drafting_item_id = s.drafting_item_id
          ORDER BY content_revision DESC
          LIMIT 1
       ) d ON true
      WHERE s.id = $1::uuid
      LIMIT 1`,
    [emailSendId],
  );
  return rows[0] ?? null;
}

function buildThreadAwareInbound(input: {
  firstInbound: string;
  ourAutoReply: string;
  secondInbound: string;
}): string {
  // Production writer only sees "lead reply"; pack prior turns so round-2 drafts
  // are grounded without changing the global prompt contract permanently.
  return [
    '[Prior lead reply]',
    input.firstInbound.trim(),
    '',
    '[Our reply to them]',
    input.ourAutoReply.trim(),
    '',
    '[Their newest reply — draft only against this]',
    input.secondInbound.trim(),
  ].join('\n');
}

async function main(): Promise<void> {
  const round1Path = process.argv[2]
    ?? path.join(root, 'fixtures', 'reply-simulations', 'sim-30592d19.json');
  const round1 = JSON.parse(fs.readFileSync(round1Path, 'utf8')) as {
    runId: string;
    results: Round1Result[];
  };

  if (round1.results.length < 15) {
    throw new Error(`Expected 15 round-1 results in ${round1Path}`);
  }

  const mode = getDraftingMode();
  const runId = randomUUID().slice(0, 8);
  console.log(JSON.stringify({
    phase: 'start',
    draftingMode: mode,
    parentRun: round1.runId,
    note: 'Round-2 lead replies + follow-up drafts. No Resend.',
  }));

  const results: Array<Record<string, unknown>> = [];

  for (let i = 0; i < 15; i += 1) {
    const prior = round1.results[i]!;
    const second = ROUND2_REPLIES[i]!;
    const ctx = await loadOutboundContext(prior.emailSendId);
    if (!ctx) throw new Error(`Missing outbound context for ${prior.emailSendId}`);

    console.log(`\n[${i + 1}/15] ${prior.lead} · ${second.label}`);

    const providerEmailId = `sim-r2-${runId}-${String(i + 1).padStart(2, '0')}`;
    const started = Date.now();

    await dbQuery(
      `INSERT INTO outreach.inbound_emails (
         owner_id, campaign_id, email_send_id, drafting_item_id, provider_email_id,
         from_email, to_emails, subject, text_body, html_body, headers, received_at,
         auto_reply_skipped
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10::jsonb, now(), NULL
       )`,
      [
        ctx.owner_id,
        ctx.campaign_id,
        prior.emailSendId,
        ctx.drafting_item_id,
        providerEmailId,
        ctx.to_email,
        [`reply+${ctx.drafting_item_id}@replies.heliosgroup.ai`],
        prior.autoReplySubject || `Re: ${prior.outboundSubject}`,
        second.body,
        JSON.stringify({
          'x-helios-simulation': 'true',
          'x-helios-sim-run': runId,
          'x-helios-sim-round': '2',
          'x-helios-sim-label': second.label,
          'x-helios-sim-parent': round1.runId,
        }),
      ],
    );

    // Production caps at one reply_sends per outbound — draft follow-up without
    // inserting a second row. Persist follow-up text on the existing row's notes
    // via used_tools JSON extension is messy; keep follow-up in report + optional
    // body append field in results only. Also stash on inbound headers? No.
    // Store follow-up draft in reply_sends.error_message? No.
    // Write to a side column if exists? Doesn't. Report + file only for our reply #2.
    // BUT: update reply_sends used_tools to include sim_round2 marker and put
    // follow-up in a JSON file; Conversations shows second inbound which is the ask.

    try {
      const draft = await runReplyWrite({
        replySendId: `sim-r2-${runId}-${i + 1}`,
        senderDisplayName: 'Lucas Figueroa',
        senderEmail: ctx.from_email,
        leadName: ctx.lead_name,
        leadCompany: ctx.lead_company,
        leadEmail: ctx.to_email,
        originalSubject: prior.outboundSubject,
        originalBody: ctx.body ?? '',
        inboundSubject: prior.autoReplySubject || `Re: ${prior.outboundSubject}`,
        inboundBody: buildThreadAwareInbound({
          firstInbound: prior.inbound,
          ourAutoReply: prior.autoReplyBody,
          secondInbound: second.body,
        }),
      });

      const websiteToolUsed = draft.usedTools.includes('refer_helios_website');
      const findings = lintReplyBody(draft.bodyText, { websiteToolUsed });
      const bodyText = normalizeDraftText(draft.bodyText);
      const lintCodes = findings.map((f) => f.code).join(',');

      results.push({
        index: i + 1,
        label: second.label,
        tone: second.tone,
        lead: prior.lead,
        company: prior.company,
        status: findings.length ? 'failed_lint' : 'drafted_no_send',
        lint: lintCodes || null,
        outboundSubject: prior.outboundSubject,
        round1Inbound: prior.inbound,
        round1AutoReply: prior.autoReplyBody,
        round2Inbound: second.body,
        round2AutoReply: findings.length ? null : bodyText,
        usedTools: draft.usedTools,
        costUsd: draft.usage.costUsd,
        generationMode: draft.generationMode,
        ms: Date.now() - started,
        emailSendId: prior.emailSendId,
        conversationsUrl: `/hub/conversations?thread=${prior.emailSendId}`,
      });

      if (findings.length) {
        console.log(`  FAILED lint ${lintCodes}`);
      } else {
        console.log(`  OK (${draft.generationMode}) cost=${draft.usage.costUsd}`);
        console.log(`  --- lead round-2 ---\n${second.body}`);
        console.log(`  --- our follow-up (not sent) ---\n${bodyText}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        index: i + 1,
        label: second.label,
        lead: prior.lead,
        status: 'error',
        error: message,
        round2Inbound: second.body,
        emailSendId: prior.emailSendId,
      });
      console.error(`  ERROR ${message}`);
    }
  }

  const outDir = path.join(root, 'fixtures', 'reply-simulations');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `sim-r2-${runId}.json`);
  fs.writeFileSync(outPath, JSON.stringify({
    runId,
    parentRun: round1.runId,
    draftingMode: mode,
    results,
  }, null, 2));

  const mdPath = path.join(outDir, `sim-r2-${runId}.md`);
  const md = [
    `# Reply simulation round 2 — ${runId}`,
    '',
    `Parent: \`${round1.runId}\` · Mode: \`${mode}\` · No emails sent`,
    '',
    'Threads now include a second lead inbound in `/hub/conversations`.',
    'Follow-up drafts below were produced by the reply writer but not sent (one auto-reply cap per outbound).',
    '',
    ...results.flatMap((r) => [
      `## ${r.index}. ${r.lead} (${r.company ?? '—'}) — ${r.label}`,
      '',
      `Tone: ${r.tone ?? '—'} · Status: **${r.status}**`,
      '',
      '**Lead reply #1**',
      '',
      '```',
      String(r.round1Inbound ?? ''),
      '```',
      '',
      '**Our auto-reply #1**',
      '',
      '```',
      String(r.round1AutoReply ?? ''),
      '```',
      '',
      '**Lead reply #2 (new)**',
      '',
      '```',
      String(r.round2Inbound ?? ''),
      '```',
      '',
      '**Our follow-up draft #2 (not sent)**',
      '',
      '```',
      String(r.round2AutoReply ?? r.error ?? r.lint ?? ''),
      '```',
      '',
      r.conversationsUrl ? `UI: ${r.conversationsUrl}` : '',
      '',
    ]),
  ].join('\n');
  fs.writeFileSync(mdPath, md);

  const ok = results.filter((r) => r.status === 'drafted_no_send').length;
  const totalCost = results.reduce((sum, r) => sum + Number(r.costUsd ?? 0), 0);
  console.log('\n' + JSON.stringify({
    phase: 'done',
    runId,
    ok,
    failed: results.length - ok,
    totalCostUsdApprox: totalCost.toFixed(4),
    reportJson: outPath,
    reportMd: mdPath,
    hub: 'http://localhost:3000/hub/conversations',
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
