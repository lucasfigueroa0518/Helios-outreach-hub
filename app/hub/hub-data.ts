import { requestJson } from '@/lib/client-request';

const TTL_MS = 20_000;
const cache = new Map<string, { at: number; data: unknown }>();
const inflight = new Map<string, Promise<unknown>>();

/** Fast GETs for hub pages: dedupe in-flight requests and briefly cache responses. */
export async function hubGetJson<T>(url: string, options?: { force?: boolean }): Promise<T> {
  if (!options?.force) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < TTL_MS) {
      return hit.data as T;
    }
    const pending = inflight.get(url);
    if (pending) return pending as Promise<T>;
  }

  const request = requestJson<T>(url)
    .then((data) => {
      cache.set(url, { at: Date.now(), data });
      return data;
    })
    .finally(() => {
      inflight.delete(url);
    });

  if (!options?.force) inflight.set(url, request);
  return request;
}

/** Prefetch a single hub API; never fan out many session-pool connections at once. */
export function prefetchHubJson(url: string): void {
  void hubGetJson(url).catch(() => undefined);
}

export function invalidateHubCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix) || key.includes(prefix)) cache.delete(key);
  }
}

export const HUB_TAB_PREFETCH: Record<string, string[]> = {
  campaigns: ['/api/campaigns'],
  queue: ['/api/send-queue'],
  analytics: ['/api/analytics/summary?period=week'],
  conversations: ['/api/conversations'],
};
