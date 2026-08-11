import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import {
  decryptToken,
  encryptToken,
  tokenSuffix,
} from '../lib/dashboards/crypto';
import { scrubSecrets } from '../lib/dashboards/scrub-logs';

describe('dashboards crypto', () => {
  it('round-trips AES-256-GCM', () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const sample = 'ghp_ExampleTokenValue1234';
    const enc = encryptToken(sample);
    assert.equal(decryptToken(enc.encryptedToken, enc.iv, enc.authTag), sample);
    assert.equal(tokenSuffix(sample), '1234');
  });

  it('rejects tampered ciphertext', () => {
    process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString('base64');
    const enc = encryptToken('ghp_ExampleTokenValue1234');
    const buf = Buffer.from(enc.encryptedToken, 'base64');
    buf[0] ^= 0xff;
    assert.throws(() =>
      decryptToken(buf.toString('base64'), enc.iv, enc.authTag),
    );
  });

  it('scrubs PAT-like strings from logs', () => {
    const msg = scrubSecrets('failed ghp_ABCDEFGhij1234567890 and github_pat_11AAAA_BBBB');
    assert.ok(!msg.includes('ghp_'));
    assert.ok(!msg.includes('github_pat_'));
    assert.ok(msg.includes('[REDACTED]'));
  });
});
