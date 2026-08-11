import https from 'node:https';

const DECK_BUCKET = 'dashboards-decks';

type StorageJson = { message?: string };

function getSettings() {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRole) throw new Error('Supabase Storage is not configured');
  return { baseUrl, serviceRole };
}

function encodePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function uploadDeckObject(
  path: string,
  body: Buffer,
  contentType = 'application/pdf',
): Promise<void> {
  const { baseUrl, serviceRole } = getSettings();
  const url = new URL(
    `/storage/v1/object/${DECK_BUCKET}/${encodePath(path)}`,
    baseUrl,
  );
  await new Promise<void>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'POST',
        rejectUnauthorized: false,
        headers: {
          apikey: serviceRole,
          authorization: `Bearer ${serviceRole}`,
          'content-type': contentType,
          'content-length': body.byteLength,
          'x-upsert': 'true',
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            const text = Buffer.concat(chunks).toString('utf8');
            reject(new Error(`Deck upload failed (${status}): ${text.slice(0, 200)}`));
            return;
          }
          resolve();
        });
      },
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

export async function downloadDeckObject(path: string): Promise<Buffer> {
  const { baseUrl, serviceRole } = getSettings();
  const url = new URL(
    `/storage/v1/object/${DECK_BUCKET}/${encodePath(path)}`,
    baseUrl,
  );
  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'GET',
        rejectUnauthorized: false,
        headers: {
          apikey: serviceRole,
          authorization: `Bearer ${serviceRole}`,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 300) {
            reject(new Error(`Deck download failed (${response.statusCode})`));
            return;
          }
          resolve(Buffer.concat(chunks));
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

export async function removeDeckObject(path: string): Promise<void> {
  const { baseUrl, serviceRole } = getSettings();
  const url = new URL(`/storage/v1/object/${DECK_BUCKET}`, baseUrl);
  const body = JSON.stringify({ prefixes: [path] });
  await new Promise<void>((resolve, reject) => {
    const request = https.request(
      url,
      {
        method: 'DELETE',
        rejectUnauthorized: false,
        headers: {
          apikey: serviceRole,
          authorization: `Bearer ${serviceRole}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const status = response.statusCode ?? 500;
          if (status < 200 || status >= 300) {
            let message = `Deck delete failed (${status})`;
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf8')) as StorageJson;
              if (data.message) message = data.message;
            } catch {
              /* ignore */
            }
            reject(new Error(message));
            return;
          }
          resolve();
        });
      },
    );
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

export function deckApiPath(accessToken: string): string {
  return `/api/dashboards/deck/${accessToken}`;
}
