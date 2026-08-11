import crypto from 'node:crypto';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

function getKey(): Buffer {
  const k = process.env.TOKEN_ENCRYPTION_KEY;
  if (!k) throw new Error('TOKEN_ENCRYPTION_KEY not set');
  const buf = Buffer.from(k, 'base64');
  if (buf.length !== 32) {
    throw new Error('TOKEN_ENCRYPTION_KEY must decode to 32 bytes');
  }
  return buf;
}

export function encryptToken(plaintext: string): {
  encryptedToken: string;
  iv: string;
  authTag: string;
} {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encryptedToken: ct.toString('base64'),
    iv: iv.toString('base64'),
    authTag: tag.toString('base64'),
  };
}

export function decryptToken(
  encryptedToken: string,
  iv: string,
  authTag: string,
): string {
  const decipher = crypto.createDecipheriv(
    ALGO,
    getKey(),
    Buffer.from(iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(authTag, 'base64'));
  const pt = Buffer.concat([
    decipher.update(Buffer.from(encryptedToken, 'base64')),
    decipher.final(),
  ]);
  return pt.toString('utf8');
}

export function tokenSuffix(plaintext: string): string {
  return plaintext.slice(-4);
}
