import https from 'node:https';

export const UPLOAD_BUCKET = 'outreach-uploads';

type StorageResponse<T> = { data: T; status: number };

function getSettings() {
  const baseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRole = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!baseUrl || !serviceRole) throw new Error('Supabase Storage is not configured');
  return { baseUrl, serviceRole };
}

function storageRequest<T>(method: string, pathname: string, body?: unknown): Promise<StorageResponse<T>> {
  const { baseUrl, serviceRole } = getSettings();
  const url = new URL(`/storage/v1${pathname}`, baseUrl);
  const encoded = body === undefined ? undefined : JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const request = https.request(
      url,
      {
        method,
        rejectUnauthorized: false,
        headers: {
          apikey: serviceRole,
          authorization: `Bearer ${serviceRole}`,
          ...(encoded ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded) } : {}),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          const status = response.statusCode ?? 500;
          let data: T;
          try {
            data = text ? JSON.parse(text) as T : {} as T;
          } catch {
            reject(new Error(`Storage returned invalid JSON (${status})`));
            return;
          }
          if (status < 200 || status >= 300) {
            const message = typeof data === 'object' && data && 'message' in data
              ? String(data.message)
              : `Storage request failed (${status})`;
            reject(new Error(message));
            return;
          }
          resolve({ data, status });
        });
      },
    );
    request.on('error', reject);
    if (encoded) request.write(encoded);
    request.end();
  });
}

function encodePath(path: string) {
  return path.split('/').map(encodeURIComponent).join('/');
}

export async function downloadStoredObject(path: string): Promise<Buffer> {
  const { baseUrl, serviceRole } = getSettings();
  const url = new URL(`/storage/v1/object/${UPLOAD_BUCKET}/${encodePath(path)}`, baseUrl);
  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method: 'GET',
      rejectUnauthorized: false,
      headers: { apikey: serviceRole, authorization: `Bearer ${serviceRole}` },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        if ((response.statusCode ?? 500) >= 300) {
          reject(new Error(`Storage download failed (${response.statusCode})`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
    request.on('error', reject);
    request.end();
  });
}

export async function createSignedUpload(path: string) {
  const { baseUrl } = getSettings();
  const { data } = await storageRequest<{ url: string; token: string }>(
    'POST',
    `/object/upload/sign/${UPLOAD_BUCKET}/${encodePath(path)}`,
  );
  return {
    token: data.token,
    uploadUrl: new URL(`/storage/v1${data.url}`, baseUrl).toString(),
  };
}

export async function removeStoredObject(path: string) {
  await storageRequest('DELETE', `/object/${UPLOAD_BUCKET}/${encodePath(path)}`);
}
