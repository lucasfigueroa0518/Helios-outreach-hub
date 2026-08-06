// Resolves MX records over DNS-over-HTTPS instead of node:dns/promises.
//
// node:dns/promises (resolveMx/resolve4/etc.) issues raw UDP queries via
// c-ares to the OS-configured nameserver. On some networks (observed here:
// corporate proxy/VPN that intercepts hostname-based DNS-over-HTTPS traffic
// and raw UDP:53 alike) that path returns ECONNREFUSED for every domain,
// silently degrading to 'unknown' and making MX verification a no-op. Plain
// fetch()-based HTTPS (used by DNS-over-HTTPS) works reliably through the
// same network. Querying the resolver by IP literal (not hostname) also
// avoids hostname-based interception. This is also more portable for
// serverless/edge runtimes that don't expose raw UDP sockets at all.
const DOH_ENDPOINT = 'https://1.1.1.1/dns-query';

export type MxRecord = { priority: number; exchange: string };

type DohAnswer = { name: string; type: number; TTL: number; data: string };
type DohResponse = { Status: number; Answer?: DohAnswer[] };

function parseMxAnswer(data: string): MxRecord | null {
  const match = data.match(/^(\d+)\s+(\S+)\.?$/);
  if (!match) return null;
  return { priority: Number(match[1]), exchange: match[2] };
}

/**
 * Returns MX records for a domain, or an empty array for NXDOMAIN. Throws
 * for transport-level failures (timeout, non-2xx, malformed response) so
 * callers can distinguish "no mail server" from "couldn't check".
 */
export async function resolveMxOverHttps(domain: string, timeoutMs = 5000): Promise<MxRecord[]> {
  const url = new URL(DOH_ENDPOINT);
  url.searchParams.set('name', domain);
  url.searchParams.set('type', 'MX');
  const response = await fetch(url, {
    headers: { accept: 'application/dns-json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`DoH MX query failed (${response.status})`);
  const body = await response.json() as DohResponse;
  if (body.Status === 3) return []; // NXDOMAIN — domain does not exist
  if (body.Status !== 0) throw new Error(`DoH MX query returned status ${body.Status}`);
  return (body.Answer ?? []).flatMap((entry) => {
    const record = parseMxAnswer(entry.data);
    return record ? [record] : [];
  });
}
