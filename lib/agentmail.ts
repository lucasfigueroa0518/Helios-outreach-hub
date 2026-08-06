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
  from?: string;
  to?: string[];
  subject?: string;
  preview?: string;
  text?: string;
  html?: string;
  in_reply_to?: string;
  references?: string[];
  timestamp?: string;
  created_at?: string;
};

export type AgentMailSendResult = {
  message_id: string;
  thread_id: string;
  sent_at: string;
};

function agentMailApiKey() {
  const key = process.env.AGENT_MAIL_API?.trim();
  if (!key) throw new Error('AGENT_MAIL_API is not configured');
  return key;
}

export function agentMailInboxId() {
  return process.env.AGENTMAIL_INBOX_ID?.trim() || 'lafwh@agentmail.to';
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

export async function agentMailSendProbe(to: string, leadId: string): Promise<AgentMailSendResult> {
  const inboxId = agentMailInboxId();
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
  const inboxId = agentMailInboxId();
  const params = new URLSearchParams();
  if (options.after) params.set('after', options.after);
  if (options.limit) params.set('limit', String(options.limit));
  if (options.subject) params.append('subject', options.subject);
  const query = params.toString();
  const path = `/inboxes/${inboxPath(inboxId)}/messages${query ? `?${query}` : ''}`;
  const result = await agentMailRequest<{ messages?: AgentMailMessageItem[] }>(path);
  return result.messages ?? [];
}

export async function agentMailGetMessage(messageId: string): Promise<AgentMailMessageItem> {
  const inboxId = agentMailInboxId();
  return agentMailRequest<AgentMailMessageItem>(
    `/inboxes/${inboxPath(inboxId)}/messages/${messagePath(messageId)}`,
  );
}
