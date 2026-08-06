/**
 * Safe client-side JSON request helper.
 * Handles non-JSON / HTML error pages (e.g. Next.js 500 internal error, <!DOCTYPE html>)
 * without throwing raw SyntaxError ("Unexpected token '<', <!DOCTYPE...").
 */

export async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const contentType = response.headers.get('content-type') || '';

  if (!contentType.includes('application/json')) {
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      if (text.trim().toLowerCase().startsWith('<!doctype') || text.trim().startsWith('<')) {
        throw new Error(`Server error (HTTP ${response.status}) - please retry`);
      }
      throw new Error(text || `Request failed with status ${response.status}`);
    }
    throw new Error('Server returned an unexpected non-JSON response');
  }

  let data: any;
  try {
    data = await response.json();
  } catch {
    throw new Error('Invalid JSON payload returned from server');
  }

  if (!response.ok) {
    throw new Error(data?.error ?? `Request failed with status ${response.status}`);
  }

  return data as T;
}
