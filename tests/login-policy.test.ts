import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAllowedLoginEmail,
  isOpenAllowlistForbidden,
  loginEmailPolicyMessage,
} from '@/lib/login-policy';

test('allowlist accepts heliosgroup.ai when configured', () => {
  const previous = process.env.ALLOWED_EMAIL_DOMAINS;
  try {
    process.env.ALLOWED_EMAIL_DOMAINS = 'heliosgroup.ai';
    assert.equal(isAllowedLoginEmail('lucas@heliosgroup.ai'), true);
    assert.equal(isAllowedLoginEmail('lucas@gmail.com'), false);
    assert.equal(isAllowedLoginEmail('not-an-email'), false);
    assert.match(loginEmailPolicyMessage(), /heliosgroup\.ai/);
  } finally {
    if (previous === undefined) delete process.env.ALLOWED_EMAIL_DOMAINS;
    else process.env.ALLOWED_EMAIL_DOMAINS = previous;
  }
});

test('production refuses open allowlist', () => {
  assert.equal(isOpenAllowlistForbidden('production', '*'), true);
  assert.equal(isOpenAllowlistForbidden('production', ''), true);
  assert.equal(isOpenAllowlistForbidden('production', 'heliosgroup.ai'), false);
  assert.equal(isOpenAllowlistForbidden('development', '*'), false);
});
