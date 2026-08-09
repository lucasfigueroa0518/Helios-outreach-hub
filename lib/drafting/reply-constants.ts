/** Fixed Calendly link for booking nudges (not used on suppress / pure defer acks). */
export const REPLY_CALENDLY_URL = 'https://calendly.com/lucas-heliosgroup/30min';

/** Visible website text that must be hyperlinked in HTML. */
export const REPLY_WEBSITE_VISIBLE = 'heliosgroup.ai';

export const REPLY_WEBSITE_HREF = 'https://heliosgroup.ai';

/** Delay before the worker drafts and sends an immediate auto-response. */
export const REPLY_AUTO_DELAY_MS = 60_000;

/** Max immediate auto-replies per original outbound thread. */
export const REPLY_MAX_IMMEDIATE_TURNS = 4;

export const REPLY_PROMPT_VERSION = 'reply-writer-v2-multiturn';

export type ReplyDisposition = 'reply_now' | 'defer' | 'suppress';
export type ReplySendKind = 'immediate' | 'followup';
