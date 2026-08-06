export type RenderedPage = {
  html: string;
  finalUrl: string;
};

export type SiteRenderFetch = (
  url: URL,
  options: { timeoutMs: number },
) => Promise<RenderedPage>;

/**
 * Browserless-compatible content endpoint. The adapter is intentionally small
 * and injectable so tests never contact a browser service.
 */
export async function renderSitePage(
  url: URL,
  options: { timeoutMs: number },
): Promise<RenderedPage> {
  const endpoint = process.env.BROWSER_RENDER_URL?.trim();
  if (!endpoint) throw new Error('managed browser is not configured');
  const requestUrl = new URL(endpoint);
  const token = process.env.BROWSER_RENDER_API_KEY?.trim();
  if (token && !requestUrl.searchParams.has('token')) requestUrl.searchParams.set('token', token);

  const response = await fetch(requestUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      url: url.toString(),
      gotoOptions: {
        waitUntil: 'domcontentloaded',
        timeout: options.timeoutMs,
      },
      waitForTimeout: Math.min(2_000, Math.max(250, Math.floor(options.timeoutMs / 4))),
      rejectResourceTypes: ['font', 'media'],
    }),
    signal: AbortSignal.timeout(options.timeoutMs + 1_000),
  });
  if (!response.ok) throw new Error(`managed browser HTTP ${response.status}`);
  const body = await response.text();
  if (!body.trim()) throw new Error('managed browser returned empty content');

  try {
    const parsed = JSON.parse(body) as { content?: string; html?: string; url?: string };
    const html = parsed.content ?? parsed.html;
    if (html) return { html, finalUrl: parsed.url ?? url.toString() };
  } catch {
    // Browserless /content returns HTML directly; JSON support covers compatible providers.
  }
  return { html: body, finalUrl: url.toString() };
}
