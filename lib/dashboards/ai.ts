import Anthropic from '@anthropic-ai/sdk';

import { cachedSystemText, withConversationCache } from '@/lib/anthropic-cache';
import { priceAnthropicMessages, type AnthropicUsageContract } from '@/lib/anthropic-pricing';
import { dbQuery } from '@/lib/db';
import {
  createContextUpdate,
  findClientById,
  findProjectById,
  latestUpdateWindowEnd,
} from '@/lib/dashboards/repository';
import { scrubError } from '@/lib/dashboards/scrub-logs';
import type { Bullet, ContextUpdateBullets, GenSource } from '@/lib/dashboards/types';

const JUNK_COMMIT_RE =
  /^(merge|wip|fixup!|squashed|revert "merge|chore: bump version|update readme$|^\.+$)/i;

function isJunk(title: string): boolean {
  return JUNK_COMMIT_RE.test(title) || title.trim().length < 5;
}

type ProjectForPrompt = {
  name: string;
  client: { name: string };
};

type EventForPrompt = {
  id: string;
  type: string;
  occurredAt: Date;
  title: string;
  body: string | null;
  authorName: string;
  url: string;
};

const DASHBOARD_UPDATE_SYSTEM = `You are writing a project status update for a Helios Marketing client.
Helios is an AI marketing agency. The client reads these bullets directly.

VOICE RULES (from Helios style guide):
- Editorial, confident, direct. No filler. No marketing fluff.
- Outcome-led: what shipped or moved, not what people "worked on."
- Plain about AI: "systems," "pipelines," "automations" — never "magic" or "revolutionary."
- No exclamation marks. No emoji.
- First-person plural ("we shipped," "we kicked off").
- Numbers stay in numerals.
- Title-case for product/feature names; sentence-case otherwise.`;

export function buildPrompt(
  project: ProjectForPrompt,
  readme: string | null,
  events: EventForPrompt[],
  windowStart: Date,
  windowEnd: Date,
): string {
  return `${DASHBOARD_UPDATE_SYSTEM}

${buildDashboardUserPrompt(project, readme, events, windowStart, windowEnd)}`;
}

function buildDashboardUserPrompt(
  project: ProjectForPrompt,
  readme: string | null,
  events: EventForPrompt[],
  windowStart: Date,
  windowEnd: Date,
): string {
  const eventBlock = events
    .map((e) =>
      [
        `[event:${e.id}] ${e.type} on ${e.occurredAt.toISOString()} by ${e.authorName}`,
        `Title: ${e.title}`,
        e.body ? `Body: ${e.body.slice(0, 500)}` : null,
        `URL: ${e.url}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .join('\n---\n');

  return `PROJECT CONTEXT (do not summarize this, just use it for understanding):
Project name: ${project.name}
Client: ${project.client.name}
README:
"""
${(readme ?? '').slice(0, 2000)}
"""

SCOPE:
- Summarize project activity between ${windowStart.toISOString()} and ${windowEnd.toISOString()}.
- 3–6 bullets. Each bullet = 1–2 sentences.
- Cite at least one source eventId from the inputs below for each bullet where you can.
- If there is nothing meaningful to report, return {"bullets": []}.
- Group related events into a single bullet — don't list every commit.

INPUTS (chronologically interleaved):

${eventBlock}

OUTPUT — respond with raw JSON only. Do not wrap the response in markdown code
fences (no \`\`\`json or \`\`\`) and do not add any text before or after the JSON:
{
  "bullets": [
    {
      "text": "We shipped the new checkout flow with Apple Pay support.",
      "sources": [{ "eventId": "<id from inputs above>" }]
    }
  ]
}

Cite source eventIds where you can; any eventId you cite must come from the inputs above — do not invent eventIds.
Do not invent claims that aren't grounded in the inputs.
Do not include the README in your sources — it's context only.`;
}

export function sanitizeBullets(
  bullets: Bullet[],
  eventIds: Set<string>,
): Bullet[] {
  return bullets
    .filter((b) => typeof b.text === 'string' && b.text.trim().length > 0)
    .map((b) => ({
      text: b.text,
      sources: Array.isArray(b.sources)
        ? b.sources.filter((s) => eventIds.has(s.eventId))
        : [],
    }));
}

export function parseClaudeJson(text: string): { bullets: Bullet[] } {
  const trimmed = text.trim();

  try {
    return JSON.parse(trimmed) as { bullets: Bullet[] };
  } catch {
    // fall through
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1]!.trim()) as { bullets: Bullet[] };
    } catch {
      // fall through
    }
  }

  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1)) as { bullets: Bullet[] };
  }

  throw new Error('No JSON object found in Claude response');
}

async function callClaudeWithRetry(
  client: Anthropic,
  prompt: string,
): Promise<{ bullets: Bullet[]; billedUsage: AnthropicUsageContract }> {
  const system = cachedSystemText(DASHBOARD_UPDATE_SYSTEM);
  const userMsg: Anthropic.MessageParam = { role: 'user', content: prompt };
  const billed: Anthropic.Message[] = [];
  const modelId = 'claude-sonnet-4-5';

  const first = await client.messages.create({
    model: modelId,
    max_tokens: 1024,
    system,
    messages: withConversationCache([userMsg]),
  });
  billed.push(first);

  const firstBlock = first.content[0];
  if (!firstBlock || firstBlock.type !== 'text') {
    throw new Error('Non-text response from Claude');
  }
  const firstText = firstBlock.text;

  try {
    return {
      ...parseClaudeJson(firstText),
      billedUsage: priceAnthropicMessages(billed, { modelId }),
    };
  } catch {
    const retry = await client.messages.create({
      model: modelId,
      max_tokens: 1024,
      system,
      messages: withConversationCache([
        userMsg,
        { role: 'assistant', content: firstText },
        {
          role: 'user',
          content:
            'Your previous response was not valid JSON. Return only the JSON object, no other text.',
        },
      ]),
    });
    billed.push(retry);

    const retryBlock = retry.content[0];
    if (!retryBlock || retryBlock.type !== 'text') {
      throw new Error('Non-text response from Claude on retry');
    }
    return {
      ...parseClaudeJson(retryBlock.text),
      billedUsage: priceAnthropicMessages(billed, { modelId }),
    };
  }
}

export type GeneratedUpdate = {
  id: string;
  projectId: string;
  bullets: ContextUpdateBullets;
  windowStart: Date;
  windowEnd: Date;
  generatedAt: Date;
  generatedBy: GenSource;
};

export type GenerateOutcome =
  | {
      status: 'no_events';
      hasPriorUpdate: boolean;
      windowStart: Date;
      windowEnd: Date;
    }
  | {
      status: 'generated';
      update: GeneratedUpdate;
      source: 'ai' | 'fallback';
      aiError?: string;
    };

const EVENT_LABEL: Record<string, string> = {
  COMMIT: 'Commit',
  PR_MERGED: 'Merged PR',
  ISSUE_CLOSED: 'Closed issue',
  RELEASE: 'Release',
};

export function buildFallbackBullets(
  events: { id: string; type: string; title: string }[],
): Bullet[] {
  return events.slice(0, 6).map((e) => ({
    text: `${EVENT_LABEL[e.type] ?? e.type}: ${e.title}`,
    sources: [{ eventId: e.id }],
  }));
}

export async function generateUpdate(
  projectId: string,
  opts?: { manual?: boolean; generatedBy?: GenSource },
): Promise<GenerateOutcome> {
  const project = await findProjectById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const client = await findClientById(project.clientId);
  if (!client) throw new Error(`Client for project ${projectId} not found`);

  const priorWindowEnd = await latestUpdateWindowEnd(projectId);
  const manual = opts?.manual ?? false;
  const hasPriorUpdate = Boolean(priorWindowEnd);
  const windowEnd = new Date();
  const fourteenDaysAgo = new Date(windowEnd.getTime() - 14 * 24 * 60 * 60 * 1000);
  const lowerBound: Date | null = manual ? fourteenDaysAgo : (priorWindowEnd ?? null);

  type EventRow = {
    id: string;
    type: string;
    occurred_at: Date;
    title: string;
    body: string | null;
    author_name: string;
    url: string;
  };

  const { rows: rawEvents } = lowerBound
    ? await dbQuery<EventRow>(
        `SELECT id, type, occurred_at, title, body, author_name, url
         FROM dashboards.repo_events
         WHERE project_id = $1
           AND type IN ('COMMIT', 'PR_MERGED', 'ISSUE_CLOSED')
           AND occurred_at >= $2 AND occurred_at < $3
         ORDER BY occurred_at ASC
         LIMIT 30`,
        [projectId, lowerBound, windowEnd],
      )
    : await dbQuery<EventRow>(
        `SELECT id, type, occurred_at, title, body, author_name, url
         FROM dashboards.repo_events
         WHERE project_id = $1
           AND type IN ('COMMIT', 'PR_MERGED', 'ISSUE_CLOSED')
           AND occurred_at < $2
         ORDER BY occurred_at ASC
         LIMIT 30`,
        [projectId, windowEnd],
      );

  const events = rawEvents
    .filter((e) => e.type !== 'COMMIT' || !isJunk(e.title))
    .map((e) => ({
      id: e.id,
      type: e.type,
      occurredAt: e.occurred_at,
      title: e.title,
      body: e.body,
      authorName: e.author_name,
      url: e.url,
    }));

  if (events.length === 0) {
    const emptyWindowStart = lowerBound ?? project.createdAt;
    console.log('[generateUpdate] no events to summarize', {
      manual,
      lowerBound: lowerBound?.toISOString() ?? null,
      windowEnd: windowEnd.toISOString(),
    });
    return {
      status: 'no_events',
      hasPriorUpdate,
      windowStart: emptyWindowStart,
      windowEnd,
    };
  }

  const windowStart: Date = manual
    ? fourteenDaysAgo
    : (priorWindowEnd ?? events[0]!.occurredAt ?? project.createdAt);

  const eventIds = new Set(events.map((e) => e.id));

  let bullets: Bullet[] = [];
  let aiError: string | undefined;
  let billedUsage: AnthropicUsageContract | null = null;
  try {
    const prompt = buildDashboardUserPrompt(
      { name: project.name, client: { name: client.name } },
      project.readmeMarkdown,
      events,
      windowStart,
      windowEnd,
    );

    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const parsed = await callClaudeWithRetry(anthropic, prompt);
    billedUsage = parsed.billedUsage;

    bullets = sanitizeBullets(parsed.bullets ?? [], eventIds).slice(0, 6);
    if (bullets.length === 0) {
      aiError = 'Claude returned no usable bullets';
    }
  } catch (e: unknown) {
    aiError = scrubError(e);
    console.error('[generateUpdate] Anthropic call failed:', aiError);
  }

  let source: 'ai' | 'fallback' = 'ai';
  if (bullets.length === 0) {
    bullets = buildFallbackBullets(events);
    source = 'fallback';
    console.log('[generateUpdate] using non-AI fallback summary', {
      reason: aiError,
      fallbackBullets: bullets.length,
    });
  }

  const bulletsJson: ContextUpdateBullets = { bullets };
  const generatedBy: GenSource =
    opts?.generatedBy ?? (opts?.manual ? 'MANUAL' : 'CRON');

  const update = await createContextUpdate({
    projectId,
    bullets: bulletsJson,
    windowStart,
    windowEnd,
    generatedBy,
    billedUsage,
  });

  console.log('[generateUpdate] persisted update', { id: update.id, source });

  return {
    status: 'generated',
    source,
    aiError,
    update: {
      id: update.id,
      projectId: update.projectId,
      bullets: bulletsJson,
      windowStart: update.windowStart,
      windowEnd: update.windowEnd,
      generatedAt: update.generatedAt,
      generatedBy: update.generatedBy,
    },
  };
}
