import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveDeliveryVerificationStatus } from '@/lib/drafting/delivery-trust';

describe('resolveDeliveryVerificationStatus', () => {
  it('does not invent valid for upload/Embark-DB emails — AgentMail or fail-open required', () => {
    assert.equal(resolveDeliveryVerificationStatus('unknown', 'direct'), 'unknown');
    assert.equal(resolveDeliveryVerificationStatus('pending', 'direct'), 'pending');
    assert.equal(resolveDeliveryVerificationStatus(null, 'from_embark_db'), 'pending');
    assert.equal(resolveDeliveryVerificationStatus('invalid', 'direct'), 'invalid');
    assert.equal(resolveDeliveryVerificationStatus('rate_limited', 'direct'), 'rate_limited');
    assert.equal(resolveDeliveryVerificationStatus('valid', 'direct'), 'valid');
  });

  it('keeps inferred / format_guess statuses as stored (null → pending)', () => {
    assert.equal(resolveDeliveryVerificationStatus('unknown', 'inferred'), 'unknown');
    assert.equal(resolveDeliveryVerificationStatus(null, 'inferred'), 'pending');
    assert.equal(resolveDeliveryVerificationStatus('rate_limited', 'format_guess'), 'rate_limited');
  });
});
