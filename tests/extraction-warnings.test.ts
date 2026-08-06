import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isNonCriticalExtractionWarning } from '@/lib/extraction-warnings';

describe('isNonCriticalExtractionWarning', () => {
  it('treats image width proceed signals as non-critical', () => {
    assert.equal(
      isNonCriticalExtractionWarning(
        'Image width 1800px exceeds 1568px — proceeding without downscale.',
      ),
      true,
    );
  });

  it('treats count close accepted mismatches as non-critical', () => {
    assert.equal(
      isNonCriticalExtractionWarning('count close (saw 10, extracted 8) — accepted'),
      true,
    );
  });

  it('keeps real count mismatches as critical', () => {
    assert.equal(
      isNonCriticalExtractionWarning('count mismatch (saw 10, extracted 7)'),
      false,
    );
  });

  it('keeps empty-leads and parse errors as critical', () => {
    assert.equal(isNonCriticalExtractionWarning('File has no usable columns'), false);
    assert.equal(isNonCriticalExtractionWarning('CSV parse: unexpected column'), false);
  });
});
