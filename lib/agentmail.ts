import {
  assertOutreachInbox,
  assertVerifyInbox,
  inferIdentitySlug,
  resolveAgentMailSenderName,
  OUTREACH_INBOX_SEEDS,
  resolveConfiguredVerifyInbox,
  SENDER_IDENTITY_DEFAULTS,
} from '@/lib/agentmail-inboxes';

const AGENTMAIL_BASE = 'https://api.agentmail.to/v0';

async function agentMailFetch(url: string, init: RequestInit = {}) {
  const tlsInsecure = process.env.AGENTMAIL_TLS_INSECURE === 'true';
  const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  if (tlsInsecure) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  try {
    return await fetch(url, init);
  } finally {
    if (tlsInsecure) {
      if (previousTlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      else process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
    }
  }
}

export type AgentMailMessageItem = {
  message_id: string;
  thread_id?: string;
  inbox_id?: string;
  from?: string;
  to?: string[];
  subject?: string;
  preview?: string;
  text?: string;
  html?: string;
  extracted_text?: string;
  in_reply_to?: string;
  references?: string[];
  labels?: string[];
  headers?: Record<string, string>;
  timestamp?: string;
  created_at?: string;
};

export type AgentMailSendResult = {
  message_id: string;
  thread_id: string;
  sent_at: string;
};

export type AgentMailAttachment = {
  filename: string;
  contentType: string;
  content: Buffer;
  contentId?: string;
  inline?: boolean;
};

function agentMailApiKey() {
  const key = process.env.AGENT_MAIL_API?.trim();
  if (!key) throw new Error('AGENT_MAIL_API is not configured');
  return key;
}

/** Verify-only inbox. Never returns an outreach address. */
export function agentMailInboxId() {
  return resolveConfiguredVerifyInbox();
}

function inboxPath(inboxId: string) {
  return encodeURIComponent(inboxId);
}

function messagePath(messageId: string) {
  return encodeURIComponent(messageId);
}

async function agentMailRequest<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await agentMailFetch(`${AGENTMAIL_BASE}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${agentMailApiKey()}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: init.signal ?? AbortSignal.timeout(30_000),
    });
  } catch (error) {
    const cause = error instanceof Error && 'cause' in error ? String(error.cause) : '';
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`AgentMail network error: ${message}${cause ? ` (${cause})` : ''}`);
  }
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`AgentMail ${response.status}: ${body.slice(0, 500)}`);
  }
  return body ? JSON.parse(body) as T : {} as T;
}

function serializeAttachments(attachments?: AgentMailAttachment[]) {
  if (!attachments?.length) return undefined;
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    content_type: attachment.contentType,
    content_disposition: attachment.inline ? 'inline' : 'attachment',
    content_id: attachment.contentId,
    content: attachment.content.toString('base64'),
  }));
}

export async function agentMailSendProbe(to: string, leadId: string): Promise<AgentMailSendResult> {
  const inboxId = assertVerifyInbox(agentMailInboxId());
  const sentAt = new Date().toISOString();
  const result = await agentMailRequest<{ message_id: string; thread_id: string }>(
    `/inboxes/${inboxPath(inboxId)}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [to],
        subject: 'a',
        text: 'f',
        labels: ['embark-mailbox-verify', `lead-${leadId.slice(0, 8)}`],
      }),
    },
  );
  return {
    message_id: result.message_id,
    thread_id: result.thread_id,
    sent_at: sentAt,
  };
}

export async function agentMailListMessages(options: {
  after?: string;
  limit?: number;
  subject?: string;
} = {}) {
  const inboxId = assertVerifyInbox(agentMailInboxId());
  return agentMailListInboxMessages(inboxId, options);
}

export async function agentMailGetMessage(messageId: string): Promise<AgentMailMessageItem> {
  const inboxId = assertVerifyInbox(agentMailInboxId());
  return agentMailGetInboxMessage(inboxId, messageId);
}

export async function agentMailListInboxMessages(
  inboxId: string,
  options: {
    after?: string;
    limit?: number;
    subject?: string;
    includeUnauthenticated?: boolean;
    includeSpam?: boolean;
  } = {},
) {
  const params = new URLSearchParams();
  if (options.after) params.set('after', options.after);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.subject) params.append('subject', options.subject);
  if (options.includeUnauthenticated) params.set('include_unauthenticated', 'true');
  if (options.includeSpam) params.set('include_spam', 'true');
  const query = params.toString();
  const path = `/inboxes/${inboxPath(inboxId)}/messages${query ? `?${query}` : ''}`;
  const result = await agentMailRequest<{ messages?: AgentMailMessageItem[] }>(path);
  return result.messages ?? [];
}

export async function agentMailListInboxThreads(
  inboxId: string,
  options: {
    limit?: number;
    includeUnauthenticated?: boolean;
    includeSpam?: boolean;
  } = {},
) {
  const params = new URLSearchParams();
  if (options.limit) params.set('limit', String(options.limit));
  if (options.includeUnauthenticated) params.set('include_unauthenticated', 'true');
  if (options.includeSpam) params.set('include_spam', 'true');
  const query = params.toString();
  const path = `/inboxes/${inboxPath(inboxId)}/threads${query ? `?${query}` : ''}`;
  const result = await agentMailRequest<{
    threads?: Array<{
      thread_id: string;
      message_count?: number;
      received_timestamp?: string | null;
      last_message_id?: string;
      senders?: string[];
    }>;
  }>(path);
  return result.threads ?? [];
}

export async function agentMailGetInboxThread(
  inboxId: string,
  threadId: string,
): Promise<{ messages: AgentMailMessageItem[] }> {
  const result = await agentMailRequest<{
    messages?: AgentMailMessageItem[];
    thread?: { messages?: AgentMailMessageItem[] };
  }>(`/inboxes/${inboxPath(inboxId)}/threads/${messagePath(threadId)}`);
  return { messages: result.messages ?? result.thread?.messages ?? [] };
}

export async function agentMailGetInboxMessage(
  inboxId: string,
  messageId: string,
): Promise<AgentMailMessageItem> {
  return agentMailRequest<AgentMailMessageItem>(
    `/inboxes/${inboxPath(inboxId)}/messages/${messagePath(messageId)}`,
  );
}

export async function agentMailSendOutreach(input: {
  inboxId: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  labels?: string[];
  headers?: Record<string, string>;
  attachments?: AgentMailAttachment[];
}): Promise<AgentMailSendResult> {
  const inboxId = assertOutreachInbox(input.inboxId);
  const sentAt = new Date().toISOString();
  const result = await agentMailRequest<{ message_id: string; thread_id: string }>(
    `/inboxes/${inboxPath(inboxId)}/messages/send`,
    {
      method: 'POST',
      body: JSON.stringify({
        to: [input.to],
        subject: input.subject,
        text: input.text,
        html: input.html,
        reply_to: input.replyTo ? [input.replyTo] : undefined,
        labels: input.labels,
        headers: input.headers,
        attachments: serializeAttachments(input.attachments),
      }),
    },
  );
  return {
    message_id: result.message_id,
    thread_id: result.thread_id,
    sent_at: sentAt,
  };
}

export async function agentMailReplyOutreach(input: {
  inboxId: string;
  messageId: string;
  text: string;
  html?: string;
  labels?: string[];
  attachments?: AgentMailAttachment[];
}): Promise<AgentMailSendResult> {
  const inboxId = assertOutreachInbox(input.inboxId);
  const sentAt = new Date().toISOString();
  const result = await agentMailRequest<{ message_id: string; thread_id: string }>(
    `/inboxes/${inboxPath(inboxId)}/messages/${messagePath(input.messageId)}/reply`,
    {
      method: 'POST',
      body: JSON.stringify({
        text: input.text,
        html: input.html,
        labels: input.labels,
        attachments: serializeAttachments(input.attachments),
      }),
    },
  );
  return {
    message_id: result.message_id,
    thread_id: result.thread_id,
    sent_at: sentAt,
  };
}

export async function agentMailGetInbox(inboxId: string): Promise<{
  inbox_id: string;
  email?: string;
  display_name?: string | null;
}> {
  const id = assertOutreachInbox(inboxId);
  return agentMailRequest(`/inboxes/${inboxPath(id)}`);
}

export async function agentMailUpdateInboxDisplayName(
  inboxId: string,
  displayName: string,
): Promise<{ display_name?: string | null }> {
  const id = assertOutreachInbox(inboxId);
  const name = resolveAgentMailSenderName(displayName, id);
  return agentMailRequest(`/inboxes/${inboxPath(id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ display_name: name }),
  });
}

const ensuredDisplayNames = new Map<string, string>();

/** Inbox display_name is what Gmail shows as From. Never leave the AgentMail default. */
export async function ensureOutreachInboxDisplayName(
  inboxId: string,
  displayName: string | null | undefined,
): Promise<string> {
  const id = assertOutreachInbox(inboxId);
  const name = resolveAgentMailSenderName(displayName, id);
  if (ensuredDisplayNames.get(id) === name) return name;
  await agentMailUpdateInboxDisplayName(id, name);
  ensuredDisplayNames.set(id, name);
  return name;
}

export async function syncOutreachInboxDisplayNames(): Promise<Array<{
  inbox: string;
  display_name: string;
}>> {
  const results: Array<{ inbox: string; display_name: string }> = [];
  for (const seed of OUTREACH_INBOX_SEEDS) {
    const displayName = SENDER_IDENTITY_DEFAULTS[inferIdentitySlug({
      identitySlug: seed.identity,
      workEmail: seed.email,
    })].displayName;
    const formatted = await ensureOutreachInboxDisplayName(seed.email, displayName);
    results.push({ inbox: seed.email, display_name: formatted });
  }
  return results;
}
