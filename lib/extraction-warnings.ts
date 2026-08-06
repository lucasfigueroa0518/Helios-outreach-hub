/**
 * Classify enrichment upload extraction signals for UI tone.
 * Non-critical = informational OK-to-proceed (dark green), not orange warning.
 */
export function isNonCriticalExtractionWarning(message: string): boolean {
  const text = message.trim();
  if (!text) return false;
  if (/^Image width \d+px exceeds \d+px — proceeding without downscale\.$/i.test(text)) {
    return true;
  }
  if (/^count close \(saw \d+, extracted \d+\) — accepted$/i.test(text)) {
    return true;
  }
  return false;
}
