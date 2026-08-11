/**
 * Process-local cap on concurrent Anthropic drafting calls (research + adversarial + write).
 * Prevents RPM/TPM storms when lane concurrency is raised. On 429, callers should backoff
 * and optionally call `shrinkDraftingAnthropicLimit()`.
 *
 * Ceiling matches lane admission via resolveAnthropicMaxInflight().
 */

import { resolveAnthropicMaxInflight } from '@/lib/drafting/provider-admission';

const RESTORE_QUIET_MS = 30_000;
const RESTORE_STEP_MS = 5_000;
const SHRINK_PRESSURE_WINDOW_MS = 30_000;

function resolveLimit(): number {
  return resolveAnthropicMaxInflight();
}

let limit = resolveLimit();
let inFlight = 0;
interface Waiter {
  admit: () => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}
const waiters: Waiter[] = [];
let lastRateLimitAt: number | null = null;
let lastShrinkAt: number | null = null;
let lastShrinkReason: string | null = null;
let lastRestoreAt: number | null = null;
let shrinkCount = 0;
let restoreCount = 0;

function abortError(signal?: AbortSignal): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('Drafting Anthropic waiter aborted');
  error.name = 'AbortError';
  return error;
}

function pump(): void {
  while (inFlight < limit && waiters.length > 0) {
    const next = waiters.shift();
    if (!next) continue;
    if (next.signal?.aborted) {
      next.reject(abortError(next.signal));
      continue;
    }
    if (next.signal && next.onAbort) {
      next.signal.removeEventListener('abort', next.onAbort);
    }
    next.admit();
  }
}

export function draftingAnthropicInFlight(): number {
  return inFlight;
}

export function draftingAnthropicLimit(): number {
  return limit;
}

export function draftingAnthropicSnapshot() {
  return {
    configuredLimit: resolveLimit(),
    effectiveLimit: limit,
    inFlight,
    waiters: waiters.length,
    lastRateLimitAt,
    lastShrinkAt,
    lastShrinkReason,
    lastRestoreAt,
    shrinkCount,
    restoreCount,
  };
}

/** Temporarily shrink once per pressure window after a 429; never below 1. */
export function shrinkDraftingAnthropicLimit(
  nowMs = Date.now(),
  reason = 'provider_rate_limit',
): void {
  lastRateLimitAt = nowMs;
  lastShrinkReason = reason;
  if (lastShrinkAt !== null && nowMs - lastShrinkAt < SHRINK_PRESSURE_WINDOW_MS) return;
  limit = Math.max(1, Math.floor(limit / 2));
  lastShrinkAt = nowMs;
  shrinkCount += 1;
}

/** Restore toward configured env ceiling after quiet period / success. */
export function restoreDraftingAnthropicLimit(nowMs = Date.now()): void {
  const configured = resolveLimit();
  if (limit >= configured) return;
  if (lastRateLimitAt !== null && nowMs - lastRateLimitAt < RESTORE_QUIET_MS) return;
  if (lastRestoreAt !== null && nowMs - lastRestoreAt < RESTORE_STEP_MS) return;
  limit = Math.min(configured, limit + 1);
  lastRestoreAt = nowMs;
  restoreCount += 1;
  pump();
}

export function resetDraftingAnthropicStateForTests(configuredLimit = resolveLimit()): void {
  if (inFlight !== 0 || waiters.length !== 0) {
    throw new Error('Cannot reset drafting Anthropic semaphore while work is active');
  }
  limit = Math.max(1, Math.min(12, Math.floor(configuredLimit)));
  lastRateLimitAt = null;
  lastShrinkAt = null;
  lastShrinkReason = null;
  lastRestoreAt = null;
  shrinkCount = 0;
  restoreCount = 0;
}

export async function withDraftingAnthropicSlot<T>(
  operation: () => Promise<T>,
  options: { signal?: AbortSignal } = {},
): Promise<T> {
  await new Promise<void>((resolve, reject) => {
    const signal = options.signal;
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    if (inFlight < limit) {
      inFlight += 1;
      resolve();
      return;
    }
    const waiter: Waiter = {
      signal,
      reject,
      admit: () => {
        inFlight += 1;
        resolve();
      },
    };
    waiter.onAbort = () => {
      const index = waiters.indexOf(waiter);
      if (index >= 0) waiters.splice(index, 1);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', waiter.onAbort, { once: true });
    waiters.push(waiter);
  });

  try {
    const result = await operation();
    restoreDraftingAnthropicLimit();
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/\b429\b/.test(message) || /\b529\b/.test(message) || /rate.?limit/i.test(message) || /overloaded/i.test(message)) {
      shrinkDraftingAnthropicLimit(Date.now(), message.includes('529') || /overloaded/i.test(message)
        ? 'provider_overloaded'
        : 'provider_rate_limit');
    }
    throw error;
  } finally {
    inFlight = Math.max(0, inFlight - 1);
    pump();
  }
}
