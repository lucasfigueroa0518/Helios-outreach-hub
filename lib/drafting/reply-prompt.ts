import type Anthropic from '@anthropic-ai/sdk';

import {
  REPLY_CALENDLY_URL,
  REPLY_PROMPT_VERSION,
  type ReplyDisposition,
} from '@/lib/drafting/reply-constants';

export { REPLY_PROMPT_VERSION };

export type ReplyThreadMessage = {
  role: 'outbound' | 'inbound' | 'auto_reply';
  at?: string | null;
  subject?: string | null;
  body: string;
};

export type ReplyPromptContext = {
  skillContent: string;
  senderDisplayName: string;
  senderEmail: string;
  leadName: string | null;
  leadCompany: string | null;
  leadEmail: string;
  originalSubject: string;
  originalBody: string;
  inboundSubject: string | null;
  inboundBody: string;
  /** Prior + current turns for multi-turn context. */
  thread?: ReplyThreadMessage[];
  /** When drafting a scheduled follow-up. */
  mode?: 'immediate' | 'followup';
  deferReason?: string | null;
};

export function buildReplySystemPrompt(skillContent: string): string {
  return [
    'You write short professional email replies for Helios outreach threads.',
    'Follow the reply-response skill exactly.',
    'Choose disposition: reply_now, defer, or suppress.',
    'Never invent Helios facts. Prefer the website referral tool over overclaiming from positioning.',
    `When includeCalendly is true, the body must contain this exact URL: ${REPLY_CALENDLY_URL}`,
    '',
    '## Reply-response skill',
    skillContent.trim(),
  ].join('\n');
}

export function buildReplyUserPrompt(ctx: ReplyPromptContext): string {
  const leadLabel = [ctx.leadName, ctx.leadCompany].filter(Boolean).join(' · ') || ctx.leadEmail;
  const mode = ctx.mode ?? 'immediate';
  const lines = [
    mode === 'followup'
      ? 'Draft the deferred follow-up email. They asked to be contacted later. disposition must be reply_now with includeCalendly true.'
      : 'Draft the next auto-response for this thread. Choose disposition carefully.',
    'Use tools only if the lead explicitly asked for more information.',
    'Finish by calling report_reply_output.',
    '',
    `Sender: ${ctx.senderDisplayName} <${ctx.senderEmail}>`,
    `Lead: ${leadLabel} <${ctx.leadEmail}>`,
    `Mode: ${mode}`,
  ];
  if (ctx.deferReason) {
    lines.push(`Deferred because: ${ctx.deferReason}`);
  }
  lines.push('', '## Original outbound email', `Subject: ${ctx.originalSubject}`, '', ctx.originalBody.trim() || '(empty)');

  if (ctx.thread && ctx.thread.length > 0) {
    lines.push('', '## Thread so far (oldest → newest)');
    for (const msg of ctx.thread) {
      const who = msg.role === 'outbound'
        ? 'Helios (original outbound)'
        : msg.role === 'auto_reply'
          ? 'Helios (auto-reply)'
          : 'Lead';
      lines.push('', `### ${who}${msg.at ? ` · ${msg.at}` : ''}`);
      if (msg.subject) lines.push(`Subject: ${msg.subject}`);
      lines.push(msg.body.trim() || '(empty)');
    }
  }

  lines.push(
    '',
    '## Latest lead reply (respond to this)',
    `Subject: ${ctx.inboundSubject?.trim() || '(none)'}`,
    '',
    ctx.inboundBody.trim() || '(empty body)',
  );
  return lines.join('\n');
}

export const lookupHeliosPositioningTool: Anthropic.Tool = {
  name: 'lookup_helios_positioning',
  description:
    'Read the Helios positioning document. Minimal facts only. Use when the lead asked a specific question that might be answered there. Do not overclaim.',
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description: 'What the lead asked that you hope positioning can answer',
      },
    },
    required: ['question'],
    additionalProperties: false,
  },
};

export const referHeliosWebsiteTool: Anthropic.Tool = {
  name: 'refer_helios_website',
  description:
    'Get guidance for referring the lead to heliosgroup.ai. Prefer this when they want more info about what Helios does, who we are, or case studies. Body must include bare text heliosgroup.ai.',
  input_schema: {
    type: 'object',
    properties: {
      reason: {
        type: 'string',
        description: 'Why you are referring them to the website',
      },
    },
    required: ['reason'],
    additionalProperties: false,
  },
};

export const reportReplyOutputTool: Anthropic.Tool = {
  name: 'report_reply_output',
  description: 'Submit the disposition and final reply email body.',
  input_schema: {
    type: 'object',
    properties: {
      disposition: {
        type: 'string',
        enum: ['reply_now', 'defer', 'suppress'],
        description: 'What the system should do with this inbound',
      },
      bodyText: {
        type: 'string',
        description: 'Plain-text email body to send now (ack for defer; goodbye for suppress). No signature.',
      },
      includeCalendly: {
        type: 'boolean',
        description: 'True if body includes the Calendly URL and a booking nudge is intended',
      },
      deferUntil: {
        type: 'string',
        description: 'YYYY-MM-DD when disposition=defer and a concrete date is known',
      },
      deferReason: {
        type: 'string',
        description: 'Why we are deferring (quote or paraphrase the lead timing)',
      },
      usedTools: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tool names you used, if any',
      },
      notes: {
        type: 'string',
        description: 'Optional internal note',
      },
    },
    required: ['disposition', 'bodyText', 'includeCalendly'],
    additionalProperties: false,
  },
};

export const REPLY_TOOLS: Anthropic.Tool[] = [
  lookupHeliosPositioningTool,
  referHeliosWebsiteTool,
  reportReplyOutputTool,
];

export function isReplyDisposition(value: unknown): value is ReplyDisposition {
  return value === 'reply_now' || value === 'defer' || value === 'suppress';
}
