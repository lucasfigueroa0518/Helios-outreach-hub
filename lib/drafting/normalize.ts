import { createHash } from 'node:crypto';
import type {
  EffectiveLeadFields,
  InputOverrides,
  InputSnapshot,
  RequiredDraftingFieldKey,
} from '@/lib/drafting/types';

const PLACEHOLDER_VALUES = new Set([
  'n/a',
  'na',
  'none',
  'unknown',
  '-',
  '--',
  '---',
  '—',
]);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Treat N/A, -, unknown, none, and whitespace-only strings as missing. */
export function isPlaceholderValue(value: string | null | undefined): boolean {
  if (value == null) return true;
  const trimmed = value.trim();
  if (!trimmed) return true;
  return PLACEHOLDER_VALUES.has(trimmed.toLowerCase());
}

export function normalizeRequiredField(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.normalize('NFC').replace(/\s+/g, ' ').trim();
  if (!trimmed || isPlaceholderValue(trimmed)) return null;
  return trimmed;
}

export function normalizeEmail(value: string | null | undefined): string | null {
  const normalized = normalizeRequiredField(value);
  if (!normalized) return null;
  const lower = normalized.toLowerCase();
  if (!EMAIL_PATTERN.test(lower)) return null;
  return lower;
}

/** Extract the first token of a normalized full name for greeting/export use. */
export function extractFirstName(fullName: string | null | undefined): string | null {
  const normalized = normalizeRequiredField(fullName);
  if (!normalized) return null;
  const firstToken = normalized.split(' ').filter(Boolean)[0];
  return firstToken ?? null;
}

export function buildEffectiveLeadFields(
  snapshot: InputSnapshot,
  overrides: InputOverrides = {},
): EffectiveLeadFields {
  const overriddenFullName = normalizeRequiredField(overrides.fullName);
  const fullName = overriddenFullName
    ?? normalizeRequiredField(snapshot.lead.fullName);
  const explicitFirstName = overriddenFullName
    ? null
    : normalizeRequiredField(snapshot.lead.firstName);
  const derivedFirstName = extractFirstName(fullName);
  return {
    email: normalizeEmail(overrides.email ?? snapshot.lead.email),
    fullName,
    firstName: explicitFirstName ?? derivedFirstName,
    company: normalizeRequiredField(overrides.company ?? snapshot.lead.company),
    title: normalizeRequiredField(overrides.title ?? snapshot.lead.title),
    workLocation: normalizeRequiredField(overrides.workLocation ?? snapshot.lead.workLocation),
  };
}

/** Materialize user overrides before any provider sees or keys research input. */
export function buildEffectiveInputSnapshot(
  snapshot: InputSnapshot,
  overrides: InputOverrides = {},
): InputSnapshot {
  const effective = buildEffectiveLeadFields(snapshot, overrides);
  const nameParts = effective.fullName?.split(' ').filter(Boolean) ?? [];
  const fullNameOverridden = normalizeRequiredField(overrides.fullName) != null;
  const connecting = overrides.connectingContext;

  return {
    ...snapshot,
    lead: {
      ...snapshot.lead,
      email: effective.email,
      fullName: effective.fullName,
      firstName: effective.firstName,
      lastName: fullNameOverridden
        ? nameParts.slice(1).join(' ') || null
        : snapshot.lead.lastName,
      company: effective.company,
      title: effective.title,
      workLocation: effective.workLocation,
    },
    connectingContext: {
      ...snapshot.connectingContext,
      introducerName: connecting?.introducerName
        ?? snapshot.connectingContext.introducerName,
      suppliedContext: connecting?.suppliedContext
        ?? snapshot.connectingContext.suppliedContext,
      linkedinConnectionDegree: connecting?.linkedinConnectionDegree
        ?? snapshot.connectingContext.linkedinConnectionDegree,
      rawCrmIndicator: connecting?.rawCrmIndicatorMeaning
        ?? snapshot.connectingContext.rawCrmIndicator,
    },
  };
}

export function missingRequiredFields(fields: EffectiveLeadFields): RequiredDraftingFieldKey[] {
  const missing: RequiredDraftingFieldKey[] = [];
  if (!fields.email) missing.push('email');
  if (!fields.fullName) missing.push('fullName');
  if (!fields.firstName) missing.push('firstName');
  if (!fields.company) missing.push('company');
  if (!fields.title) missing.push('title');
  return missing;
}

function sortCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortCanonicalValue);
  }
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    sorted[key] = sortCanonicalValue(record[key]);
  }
  return sorted;
}

/** Canonical JSON: sorted keys, compact, LF line endings. */
export function canonicalJson(value: unknown): string {
  const json = JSON.stringify(sortCanonicalValue(value));
  return json.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

export function sha256Fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function emailFingerprint(email: string): string {
  return sha256Fingerprint({ email: normalizeEmail(email) });
}

const IDENTITY_FINGERPRINT_FIELDS = [
  'fullName',
  'company',
  'title',
  'workLocation',
  'connectingContext',
  'relationship',
  'sender',
  'assets',
] as const;

/** Fields whose change invalidates research eligibility while preserving delivery-only edits. */
export function pickIdentityFingerprintInput(snapshot: InputSnapshot): Record<string, unknown> {
  return {
    fullName: normalizeRequiredField(snapshot.lead.fullName),
    company: normalizeRequiredField(snapshot.lead.company),
    title: normalizeRequiredField(snapshot.lead.title),
    workLocation: normalizeRequiredField(snapshot.lead.workLocation),
    connectingContext: snapshot.connectingContext,
    relationship: snapshot.relationship,
    sender: snapshot.sender,
    assets: snapshot.assets,
  };
}

export function identityFingerprint(snapshot: InputSnapshot): string {
  return sha256Fingerprint(pickIdentityFingerprintInput(snapshot));
}

export function inputFingerprint(
  snapshot: InputSnapshot,
  overrides: InputOverrides = {},
): string {
  const effective = buildEffectiveLeadFields(snapshot, overrides);
  return sha256Fingerprint({
    effective,
    connectingContext: snapshot.connectingContext,
    customContext: snapshot.customContext,
    relationship: snapshot.relationship,
    sender: snapshot.sender,
    assets: snapshot.assets,
    identityFields: IDENTITY_FINGERPRINT_FIELDS,
  });
}

export function normalizeDraftText(value: string): string {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
