/**
 * Auth for POST /api/webhooks/agentmail.
 * Accept a matching shared secret, or a verified Svix signature — never the
 * mere presence of a svix-id header.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const SVIX_TOLERANCE_SEC = 5 * 60;

function buffersEqual(left: Buffer, right: Buffer): boolean {
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function secretsEqual(left: string, right: string): boolean {
  return buffersEqual(Buffer.from(left), Buffer.from(right));
}

export function svixSigningKey(secret: string): Buffer {
  const trimmed = secret.trim();
  if (trimmed.startsWith('whsec_')) {
    return Buffer.from(trimmed.slice('whsec_'.length), 'base64');
  }
  return Buffer.from(trimmed, 'utf8');
}

export function verifySvixSignature(input: {
  secret: string;
  rawBody: string;
  svixId: string;
  svixTimestamp: string;
  svixSignature: string;
  nowMs?: number;
}): boolean {
  const ts = Number(input.svixTimestamp);
  if (!Number.isFinite(ts)) return false;
  const nowSec = Math.floor((input.nowMs ?? Date.now()) / 1000);
  if (Math.abs(nowSec - ts) > SVIX_TOLERANCE_SEC) return false;

  const signed = `${input.svixId}.${input.svixTimestamp}.${input.rawBody}`;
  const digest = createHmac('sha256', svixSigningKey(input.secret)).update(signed).digest('base64');
  return input.svixSignature.split(/\s+/).some((part) => {
    if (!part) return false;
    const sig = part.startsWith('v1,') ? part.slice(3) : part.replace(/^v1=/, '');
    return sig.length > 0 && buffersEqual(Buffer.from(sig), Buffer.from(digest));
  });
}

export function verifyAgentMailWebhookAuth(input: {
  secret: string;
  rawBody: string;
  svixId?: string | null;
  svixTimestamp?: string | null;
  svixSignature?: string | null;
  providedSecret?: string | null;
  nowMs?: number;
}): boolean {
  const secret = input.secret.trim();
  if (!secret) return false;
  const provided = input.providedSecret?.trim() ?? '';
  if (provided && secretsEqual(provided, secret)) return true;
  if (input.svixId && input.svixTimestamp && input.svixSignature) {
    return verifySvixSignature({
      secret,
      rawBody: input.rawBody,
      svixId: input.svixId,
      svixTimestamp: input.svixTimestamp,
      svixSignature: input.svixSignature,
      nowMs: input.nowMs,
    });
  }
  return false;
}
