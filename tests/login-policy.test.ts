import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAllowedLoginEmail,
  isOpenAllowlistForbidden,
  loginEmailPolicyMessage,
  parseAllowedEmailDomains,
} from '@/lib/login-policy';

test('allowlist accepts heliosgroup.ai when configured', () => {
  const previous = process.env.ALLOWED_EMAIL_DOMAINS;
  try {
    process.env.ALLOWED_EMAIL_DOMAINS = 'heliosgroup.ai';
    assert.equal(isAllowedLoginEmail('lucas@heliosgroup.ai'), true);
    assert.equal(isAllowedLoginEmail('lucas@gmail.com'), false);
    assert.equal(isAllowedLoginEmail('not-an-email'), false);
    assert.match(loginEmailPolicyMessage(), /isn't authorized/i);
  } finally {
    if (previous === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS;
    else process.env.ALLOWED_EMAIL_DOMAINS = previous;
  }
});

test('allowlist strips accidental quotes and accepts multiple domains', () => {
  const previous = process.env.ALLOWED_EMAIL_DOMAINS;
  try {
    process.env.ALLOWED_EMAIL_DOMAINS = '"heliosgroup.ai", heliosmarketing.org';
    assert.deepEqual(parseAllowedEmailDomains(), ['heliosgroup.ai', 'heliosmarketing.org']);
    assert.equal(isAllowedLoginEmail('lucas@heliosmarketing.org'), true);
    assert.equal(isAllowedLoginEmail('lucas@heliosgroup.ai'), true);
  } finally {
    if (previous === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS;
    else process.env.ALLOWED_EMAIL_DOMAINS = previous;
  }
});

test('production refuses open allowlist', () => {
  assert.equal(isOpenAllowlistForbidden('production', '*'), true);
  assert.equal(isOpenAllowlistForbidden('production', ''), true);
  assert.equal(isOpenAllowlistForbidden('production', 'heliosgroup.ai'), false);
  assert.equal(isOpenAllowlistForbidden('production', '"heliosgroup.ai"'), false);
  assert.equal(isOpenAllowlistForbidden('development', '*'), false);
});
