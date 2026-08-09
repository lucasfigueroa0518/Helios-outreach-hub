/**
 * Local-only simulation: attach synthetic lead replies to 15 real outbound sends,
 * run the reply writer + lint, persist results for /hub/conversations.
 *
 * NEVER calls Resend (no forward, no outbound send).
 *
 * Usage: npx tsx scripts/simulate_reply_responses.ts
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
import { REPLY_CALENDLY_URL } from '@/lib/drafting/reply-constants';
import { getDraftingMode } from '@/lib/models';

type OutboundRow = {
  id: string;
  drafting_item_id: string;
  owner_id: string;
  campaign_id: string;
  from_email: string;
  to_email: string;
  subject: string;
  body: string | null;
  lead_name: string | null;
  lead_company: string | null;
  campaign_name: string;
};

/** Hand-written synthetic inbound replies — busy, blunt, often rude/incoherent. */
const SYNTHETIC_REPLIES: Array<{
  label: string;
  tone: string;
  body: string;
}> = [
  {
    label: 'one-word-dismissive',
    tone: 'dismissive',
    body: 'pass',
  },
  {
    label: 'busy-blunt',
    tone: 'busy',
    body: 'swamped. not looking at vendors right now',
  },
  {
    label: 'confused-who-are-you',
    tone: 'confused',
    body: 'who is this\n\nand why do you have my email',
  },
  {
    label: 'short-maybe-later',
    tone: 'lukewarm',
    body: 'maybe later this quarter. ping me then',
  },
  {
    label: 'wrong-person-handoff',
    tone: 'deflecting',
    body: 'wrong person. talk to ops if anything',
  },
  {
    label: 'price-first',
    tone: 'transactional',
    body: 'ok what does this cost',
  },
  {
    label: 'skeptical-short',
    tone: 'skeptical',
    body: 'sounds like every other ai shop. whats different',
  },
  {
    label: 'typo-chaos',
    tone: 'incoherent',
    body: 'thx - in back to backs all week. maybe. send something short if u have it. or dont. idk',
  },
  {
    label: 'already-have-vendor',
    tone: 'dismissive',
    body: 'we already have people for this',
  },
  {
    label: 'polite-short-yes',
    tone: 'respectful-interest',
    body: 'Thanks for reaching out. Happy to do a short call next week if you have time.',
  },
  {
    label: 'info-ask-website',
    tone: 'curious',
    body: 'can you send more on what you actually do? website?',
  },
  {
    label: 'not-interested-hard',
    tone: 'hard-no',
    body: 'not interested. please stop emailing me',
  },
  {
    label: 'calendar-pushback',
    tone: 'guarded',
    body: 'i dont do random intro calls. whats the ask in one sentence',
  },
  {
    label: 'respectful-busy',
    tone: 'respectful-busy',
    body: 'Appreciate the note. Buried in launches until mid month. Open to reconnecting after that.',
  },
  {
    label: 'half-yes-half-rant',
    tone: 'mixed',
    body: 'fine we can talk but im not buying anything from a cold email. also our stack is a mess so if thats what you do maybe. tuesday mornings only',
  },
];

function replySubject(originalSubject: string): string {
  const cleaned = originalSubject.replace(/\r?\n/g, ' ').trim();
  if (!cleaned) return 'Re: quick chat';
  return /^re:/i.test(cleaned) ? cleaned : `Re: ${cleaned}`;
}

async function loadTargets(limit: number): Promise<OutboundRow[]> {
  const { rows } = await dbQuery<OutboundRow>(
    `SELECT s.id::text,
            s.drafting_item_id::text,
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
            nullif(trim(i.input_snapshot #>> '{lead,company}'), '') AS lead_company,
            c.name AS campaign_name
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
      WHERE s.status = 'sent'
        AND NOT EXISTS (
          SELECT 1 FROM outreach.reply_sends rs WHERE rs.email_send_id = s.id
        )
      ORDER BY s.sent_at DESC NULLS LAST
      LIMIT $1`,
    [limit],
  );
  return rows;
}

async function main(): Promise<void> {
  const mode = getDraftingMode();
  console.log(JSON.stringify({
    phase: 'start',
    draftingMode: mode,
    note: 'No Resend calls. Draft + lint + DB persist only.',
    calendly: REPLY_CALENDLY_URL,
  }));

  if (mode !== 'live') {
    console.warn('DRAFTING_MODE is not live — replies will be stubs. Set DRAFTING_MODE=live for real drafts.');
  }

  const targets = await loadTargets(SYNTHETIC_REPLIES.length);
  if (targets.length < SYNTHETIC_REPLIES.length) {
    throw new Error(
      `Need ${SYNTHETIC_REPLIES.length} sent emails without existing reply_sends; found ${targets.length}`,
    );
  }

  const runId = randomUUID().slice(0, 8);
  const results: Array<Record<string, unknown>> = [];

  for (let i = 0; i < SYNTHETIC_REPLIES.length; i += 1) {
    const outbound = targets[i]!;
    const synthetic = SYNTHETIC_REPLIES[i]!;
    const providerEmailId = `sim-local-${runId}-${String(i + 1).padStart(2, '0')}`;
    const started = Date.now();

    console.log(`\n[${i + 1}/${SYNTHETIC_REPLIES.length}] ${outbound.lead_name} · ${synthetic.label}`);

    const { rows: inboundRows } = await dbQuery<{ id: string }>(
      `INSERT INTO outreach.inbound_emails (
         owner_id, campaign_id, email_send_id, drafting_item_id, provider_email_id,
         from_email, to_emails, subject, text_body, html_body, headers, received_at,
         auto_reply_skipped
       ) VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10::jsonb, now(), NULL
       )
       RETURNING id::text`,
      [
        outbound.owner_id,
        outbound.campaign_id,
        outbound.id,
        outbound.drafting_item_id,
        providerEmailId,
        outbound.to_email,
        [`reply+${outbound.drafting_item_id}@replies.heliosgroup.ai`],
        `Re: ${outbound.subject}`,
        synthetic.body,
        JSON.stringify({
          'x-helios-simulation': 'true',
          'x-helios-sim-run': runId,
          'x-helios-sim-label': synthetic.label,
        }),
      ],
    );
    const inboundId = inboundRows[0]!.id;

    await dbQuery(
      `UPDATE outreach.email_sends
          SET replied_at = coalesce(replied_at, now()),
              reply_provider_email_id = coalesce(reply_provider_email_id, $2),
              last_event_at = now(),
              updated_at = now()
        WHERE id = $1`,
      [outbound.id, providerEmailId],
    );

    const { rows: replyRows } = await dbQuery<{ id: string }>(
      `INSERT INTO outreach.reply_sends (
         owner_id, campaign_id, inbound_email_id, drafting_item_id, email_send_id,
         status, scheduled_for
       ) VALUES ($1,$2,$3,$4,$5,'queued', now())
       RETURNING id::text`,
      [
        outbound.owner_id,
        outbound.campaign_id,
        inboundId,
        outbound.drafting_item_id,
        outbound.id,
      ],
    );
    const replySendId = replyRows[0]!.id;

    await dbQuery(
      `UPDATE outreach.reply_sends SET status = 'drafting', updated_at = now() WHERE id = $1`,
      [replySendId],
    );

    try {
      const draft = await runReplyWrite({
        replySendId,
        senderDisplayName: 'Lucas Figueroa',
        senderEmail: outbound.from_email,
        leadName: outbound.lead_name,
        leadCompany: outbound.lead_company,
        leadEmail: outbound.to_email,
        originalSubject: outbound.subject,
        originalBody: outbound.body ?? '',
        inboundSubject: `Re: ${outbound.subject}`,
        inboundBody: synthetic.body,
      });

      const websiteToolUsed = draft.usedTools.includes('refer_helios_website');
      const findings = lintReplyBody(draft.bodyText, { websiteToolUsed });
      if (findings.length > 0) {
        const codes = findings.map((f) => f.code).join(',');
        await dbQuery(
          `UPDATE outreach.reply_sends
              SET status = 'failed',
                  error_message = $2,
                  body_text = $3,
                  model_id = $4,
                  prompt_version = $5,
                  skill_version = $6,
                  skill_sha256 = $7,
                  used_tools = $8::jsonb,
                  updated_at = now()
            WHERE id = $1`,
          [
            replySendId,
            `lint:${codes}`,
            draft.bodyText,
            draft.modelId,
            draft.promptVersion,
            draft.skillVersion,
            draft.skillSha256,
            JSON.stringify(draft.usedTools),
          ],
        );
        results.push({
          index: i + 1,
          label: synthetic.label,
          tone: synthetic.tone,
          lead: outbound.lead_name,
          company: outbound.lead_company,
          status: 'failed',
          lint: codes,
          inbound: synthetic.body,
          draftBody: draft.bodyText,
          costUsd: draft.usage.costUsd,
          ms: Date.now() - started,
          emailSendId: outbound.id,
        });
        console.log(`  FAILED lint ${codes}`);
        continue;
      }

      const subject = replySubject(outbound.subject);
      const bodyText = normalizeDraftText(draft.bodyText);
      // Persist as sent for Conversations UI — no Resend call.
      await dbQuery(
        `UPDATE outreach.reply_sends
            SET status = 'sent',
                subject = $2,
                body_text = $3,
                provider_message_id = $4,
                sent_at = now(),
                model_id = $5,
                prompt_version = $6,
                skill_version = $7,
                skill_sha256 = $8,
                used_tools = $9::jsonb,
                error_message = NULL,
                updated_at = now()
          WHERE id = $1`,
        [
          replySendId,
          subject,
          bodyText,
          `sim-local-no-send-${runId}-${i + 1}`,
          draft.modelId,
          draft.promptVersion,
          draft.skillVersion,
          draft.skillSha256,
          JSON.stringify(draft.usedTools),
        ],
      );

      results.push({
        index: i + 1,
        label: synthetic.label,
        tone: synthetic.tone,
        lead: outbound.lead_name,
        company: outbound.lead_company,
        campaign: outbound.campaign_name,
        status: 'sent_simulated',
        outboundSubject: outbound.subject,
        inbound: synthetic.body,
        autoReplySubject: subject,
        autoReplyBody: bodyText,
        usedTools: draft.usedTools,
        costUsd: draft.usage.costUsd,
        generationMode: draft.generationMode,
        ms: Date.now() - started,
        emailSendId: outbound.id,
        conversationsUrl: `/hub/conversations?thread=${outbound.id}`,
      });
      console.log(`  OK (${draft.generationMode}) cost=${draft.usage.costUsd} tools=${draft.usedTools.join(',') || 'none'}`);
      console.log(`  --- inbound ---\n${synthetic.body}`);
      console.log(`  --- auto-reply ---\n${bodyText}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await dbQuery(
        `UPDATE outreach.reply_sends
            SET status = 'failed',
                error_message = $2,
                updated_at = now()
          WHERE id = $1`,
        [replySendId, message.slice(0, 4_000)],
      );
      results.push({
        index: i + 1,
        label: synthetic.label,
        lead: outbound.lead_name,
        status: 'error',
        error: message,
        inbound: synthetic.body,
        emailSendId: outbound.id,
      });
      console.error(`  ERROR ${message}`);
    }
  }

  const outDir = path.join(root, 'fixtures', 'reply-simulations');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `sim-${runId}.json`);
  fs.writeFileSync(outPath, JSON.stringify({ runId, draftingMode: mode, results }, null, 2));

  const mdPath = path.join(outDir, `sim-${runId}.md`);
  const md = [
    `# Reply simulation ${runId}`,
    '',
    `Mode: \`${mode}\` · No emails sent (Resend skipped)`,
    '',
    ...results.flatMap((r) => [
      `## ${r.index}. ${r.lead} (${r.company ?? '—'}) — ${r.label}`,
      '',
      `Tone: ${r.tone ?? '—'} · Status: **${r.status}**`,
      '',
      '**Lead reply**',
      '',
      '```',
      String(r.inbound ?? ''),
      '```',
      '',
      '**Auto-reply (system)**',
      '',
      '```',
      String(r.autoReplyBody ?? r.draftBody ?? r.error ?? ''),
      '```',
      '',
      r.conversationsUrl ? `UI: ${r.conversationsUrl}` : '',
      '',
    ]),
  ].join('\n');
  fs.writeFileSync(mdPath, md);

  const ok = results.filter((r) => r.status === 'sent_simulated').length;
  const failed = results.length - ok;
  const totalCost = results.reduce((sum, r) => sum + Number(r.costUsd ?? 0), 0);

  console.log('\n' + JSON.stringify({
    phase: 'done',
    runId,
    ok,
    failed,
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
