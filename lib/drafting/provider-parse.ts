import type {
  AskForm,
  DraftClaimLedgerEntry,
  DraftOutput,
  DraftOutputChecks,
  DraftingResearchPacket,
  EvidenceBackedStatement,
  FactConfidence,
  FactFreshness,
  FactWeight,
  FreshnessFinding,
  LeadIdentityClassification,
  ResearchFact,
  ResearchSource,
  ResolutionLevel,
  SourceFamily,
  TrustTier,
  WriterResolutionLevel,
} from '@/lib/drafting/types';
import {
  ASK_FORMS,
  CONTACT_NORM_FORMS,
  FACT_CONFIDENCE,
  FACT_FRESHNESS,
  FACT_WEIGHT,
  LEAD_IDENTITY_CLASSIFICATIONS,
  RESOLUTION_LEVELS,
  SOURCE_FAMILIES,
  TRUST_TIERS,
} from '@/lib/drafting/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid string at ${path}`);
  return value;
}

function asNullableString(value: unknown, path: string): string | null {
  if (value === null) return null;
  return asString(value, path);
}

function asOptionalNullableString(
  value: unknown,
  path: string,
  fallback: string | null = null,
): string | null {
  if (value === undefined) return fallback;
  return asNullableString(value, path);
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`Invalid boolean at ${path}`);
  return value;
}

function asStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid string[] at ${path}`);
  }
  return value;
}

function asEnum<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`Invalid enum at ${path}: ${String(value)}`);
  }
  return value as T;
}

function asNullableEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
): T | null {
  if (value === null) return null;
  return asEnum(value, allowed, path);
}

function parseFreshnessFinding(value: unknown, path: string): FreshnessFinding {
  if (!isRecord(value)) throw new Error(`Invalid freshness finding at ${path}`);
  const statusAllowed = [...FACT_FRESHNESS, 'undated-current-page'] as const;
  return {
    status: asEnum(value.status, statusAllowed, `${path}.status`),
    sourceIds: asStringArray(value.sourceIds, `${path}.sourceIds`),
    summary: asNullableString(value.summary, `${path}.summary`),
  };
}

function parseEvidenceStatement(value: unknown, path: string): EvidenceBackedStatement {
  if (!isRecord(value)) throw new Error(`Invalid evidence statement at ${path}`);
  return {
    statement: asString(value.statement, `${path}.statement`),
    sourceIds: asStringArray(value.sourceIds, `${path}.sourceIds`),
    confidence: asEnum(
      value.confidence,
      ['supported', 'tentative'] as const,
      `${path}.confidence`,
    ),
  };
}

function parseSource(value: unknown, path: string, asOf: string): ResearchSource {
  if (!isRecord(value)) throw new Error(`Invalid source at ${path}`);
  const url = asString(value.url, `${path}.url`);
  return {
    id: asString(value.id, `${path}.id`),
    url,
    title: value.title === undefined ? url : asString(value.title, `${path}.title`),
    family: asEnum(value.family, SOURCE_FAMILIES, `${path}.family`) as SourceFamily,
    trustTier: asEnum(value.trustTier, TRUST_TIERS, `${path}.trustTier`) as TrustTier,
    publishedOrUpdated: asOptionalNullableString(
      value.publishedOrUpdated,
      `${path}.publishedOrUpdated`,
    ),
    accessedAt: value.accessedAt === undefined
      ? asOf
      : asString(value.accessedAt, `${path}.accessedAt`),
    quote: asString(value.quote, `${path}.quote`),
    bindsPerson: asBoolean(value.bindsPerson, `${path}.bindsPerson`),
  };
}

function parseFactTemporal(
  value: unknown,
  path: string,
): NonNullable<ResearchFact['temporal']> {
  if (value === undefined || value === null) {
    throw new Error(`Temporal metadata is required at ${path}`);
  }
  if (!isRecord(value)) throw new Error(`Invalid temporal metadata at ${path}`);
  return {
    kind: asEnum(value.kind, ['event', 'current_state', 'evergreen'] as const, `${path}.kind`),
    eventClass: asEnum(
      value.eventClass,
      [
        'appointment', 'short_lived', 'project', 'transaction', 'deadline',
        'conference', 'announcement', 'structural', 'generic',
      ] as const,
      `${path}.eventClass`,
    ),
    eventStart: asNullableString(value.eventStart, `${path}.eventStart`),
    eventEnd: asNullableString(value.eventEnd, `${path}.eventEnd`),
    relevanceEnd: asNullableString(value.relevanceEnd, `${path}.relevanceEnd`),
    durationBasis: asEnum(
      value.durationBasis,
      ['explicit_source', 'derived_from_event', 'policy_default', 'unknown'] as const,
      `${path}.durationBasis`,
    ),
    durationSourceIds: asStringArray(value.durationSourceIds, `${path}.durationSourceIds`),
    durationEvidence: asNullableString(value.durationEvidence, `${path}.durationEvidence`),
    discourse: asEnum(
      value.discourse,
      ['current_trigger', 'ongoing', 'historical_context', 'timeless'] as const,
      `${path}.discourse`,
    ),
  };
}

function parseFact(
  value: unknown,
  path: string,
  sources: ReadonlyMap<string, ResearchSource>,
): ResearchFact {
  if (!isRecord(value)) throw new Error(`Invalid fact at ${path}`);
  const sourceIds = asStringArray(value.sourceIds, `${path}.sourceIds`);
  const firstSource = sourceIds.map((id) => sources.get(id)).find((source) => source != null);
  const normalizedClaim = asString(value.normalizedClaim, `${path}.normalizedClaim`);
  return {
    id: asString(value.id, `${path}.id`),
    normalizedClaim,
    sourceIds,
    quote: value.quote === undefined
      ? firstSource?.quote ?? ''
      : asString(value.quote, `${path}.quote`),
    family: value.family === undefined
      ? firstSource?.family ?? 'other'
      : asEnum(value.family, SOURCE_FAMILIES, `${path}.family`) as SourceFamily,
    confidence: asEnum(value.confidence, FACT_CONFIDENCE, `${path}.confidence`) as FactConfidence,
    freshness: asEnum(value.freshness, FACT_FRESHNESS, `${path}.freshness`) as FactFreshness,
    weight: asEnum(value.weight, FACT_WEIGHT, `${path}.weight`) as FactWeight,
    significanceReason: value.significanceReason === undefined
      ? normalizedClaim
      : asString(value.significanceReason, `${path}.significanceReason`),
    temporal: parseFactTemporal(value.temporal, `${path}.temporal`),
  };
}

/** Parse and type-check a report_drafting_research tool payload. */
export function parseDraftingResearchPacket(raw: unknown): DraftingResearchPacket {
  if (!isRecord(raw)) throw new Error('Research packet must be an object');
  // Models occasionally omit or emit numeric/legacy schemaVersion — coerce so a
  // otherwise-valid packet does not burn a research shard on a parse throw.
  const version = raw.schemaVersion;
  if (version !== '2') {
    if (
      version === undefined
      || version === null
      || version === '1'
      || version === 1
      || version === 2
    ) {
      raw.schemaVersion = '2';
    } else {
      throw new Error('Research packet schemaVersion must be 2');
    }
  }

  const asOf = asString(raw.asOf, 'asOf');
  const leadIdentity = raw.leadIdentity;
  if (!isRecord(leadIdentity)) throw new Error('leadIdentity missing');
  const freshness = isRecord(raw.freshness) ? raw.freshness : null;
  const prospectWorld = raw.prospectWorld;
  if (!isRecord(prospectWorld)) throw new Error('prospectWorld missing');
  const contactNorm = prospectWorld.contactNorm;
  if (!isRecord(contactNorm)) throw new Error('contactNorm missing');
  const structuralRelation = raw.structuralRelation;
  if (!isRecord(structuralRelation)) throw new Error('structuralRelation missing');
  const statusGeometry = raw.statusGeometry;
  if (!isRecord(statusGeometry)) throw new Error('statusGeometry missing');
  const resolution = raw.resolution;
  if (!isRecord(resolution)) throw new Error('resolution missing');
  const resolutionUpgrade = isRecord(raw.resolutionUpgrade) ? raw.resolutionUpgrade : null;
  const companyContextProvenance = isRecord(raw.companyContextProvenance)
    ? raw.companyContextProvenance
    : null;
  // Legacy humanPause field is ignored if the model still emits it.

  if (!Array.isArray(raw.personFacts)) throw new Error('personFacts must be an array');
  if (!Array.isArray(raw.companyFacts)) throw new Error('companyFacts must be an array');
  if (!Array.isArray(raw.roleSegmentFacts)) throw new Error('roleSegmentFacts must be an array');
  if (!Array.isArray(raw.sources)) throw new Error('sources must be an array');

  const sources = raw.sources.map((item, i) => parseSource(item, `sources[${i}]`, asOf));
  const sourcesById = new Map(sources.map((source) => [source.id, source]));
  const identitySourceIds = asStringArray(
    leadIdentity.supportingSourceIds,
    'leadIdentity.supportingSourceIds',
  );
  const defaultFreshness: FreshnessFinding = {
    status: 'undated',
    sourceIds: identitySourceIds,
    summary: null,
  };

  return {
    schemaVersion: '2',
    asOf,
    leadIdentity: {
      classification: asEnum(
        leadIdentity.classification,
        LEAD_IDENTITY_CLASSIFICATIONS,
        'leadIdentity.classification',
      ) as LeadIdentityClassification,
      suppliedSummary: asString(leadIdentity.suppliedSummary, 'leadIdentity.suppliedSummary'),
      currentSummary: asNullableString(leadIdentity.currentSummary, 'leadIdentity.currentSummary'),
      conflictSummary: asNullableString(leadIdentity.conflictSummary, 'leadIdentity.conflictSummary'),
      supportingSourceIds: identitySourceIds,
    },
    freshness: {
      employer: freshness
        ? parseFreshnessFinding(freshness.employer, 'freshness.employer')
        : defaultFreshness,
      title: freshness
        ? parseFreshnessFinding(freshness.title, 'freshness.title')
        : defaultFreshness,
      location: freshness
        ? parseFreshnessFinding(freshness.location, 'freshness.location')
        : defaultFreshness,
    },
    prospectWorld: {
      roleReality: asString(prospectWorld.roleReality, 'prospectWorld.roleReality'),
      pressures: Array.isArray(prospectWorld.pressures)
        ? prospectWorld.pressures.map((item, i) =>
          parseEvidenceStatement(item, `prospectWorld.pressures[${i}]`))
        : [],
      contactNorm: {
        form: asEnum(contactNorm.form, CONTACT_NORM_FORMS, 'contactNorm.form'),
        statement: asString(contactNorm.statement, 'contactNorm.statement'),
        sourceIds: asStringArray(contactNorm.sourceIds, 'contactNorm.sourceIds'),
        confidence: asEnum(
          contactNorm.confidence,
          ['supported', 'tentative'] as const,
          'contactNorm.confidence',
        ),
      },
      registerNotes: asStringArray(prospectWorld.registerNotes, 'prospectWorld.registerNotes'),
      commonVendorPatterns: prospectWorld.commonVendorPatterns === undefined
        ? []
        : asStringArray(prospectWorld.commonVendorPatterns, 'prospectWorld.commonVendorPatterns'),
    },
    personFacts: raw.personFacts.map((item, i) =>
      parseFact(item, `personFacts[${i}]`, sourcesById)),
    companyFacts: raw.companyFacts.map((item, i) =>
      parseFact(item, `companyFacts[${i}]`, sourcesById)),
    roleSegmentFacts: raw.roleSegmentFacts.map((item, i) =>
      parseFact(item, `roleSegmentFacts[${i}]`, sourcesById)),
    structuralRelation: {
      relation: asEnum(
        structuralRelation.relation,
        ['complementary', 'adjacent', 'potential_tension', 'unclear'] as const,
        'structuralRelation.relation',
      ),
      recipientConstraint: asOptionalNullableString(
        structuralRelation.recipientConstraint,
        'structuralRelation.recipientConstraint',
      ),
      embarkCapabilityId: asOptionalNullableString(
        structuralRelation.embarkCapabilityId,
        'structuralRelation.embarkCapabilityId',
      ),
      supportedReason: asOptionalNullableString(
        structuralRelation.supportedReason,
        'structuralRelation.supportedReason',
      ),
      tensionToName: asOptionalNullableString(
        structuralRelation.tensionToName,
        'structuralRelation.tensionToName',
      ),
      sourceIds: asStringArray(structuralRelation.sourceIds, 'structuralRelation.sourceIds'),
    },
    statusGeometry: {
      classification: asEnum(
        statusGeometry.classification,
        [
          'peer', 'sender_junior', 'sender_senior',
          'unknown_to_established', 'adjacent_principals', 'uncertain',
        ] as const,
        'statusGeometry.classification',
      ),
      safePosture: statusGeometry.safePosture === undefined
        ? 'measured_small_ask'
        : asString(statusGeometry.safePosture, 'statusGeometry.safePosture'),
      basis: statusGeometry.basis === undefined
        ? ''
        : asString(statusGeometry.basis, 'statusGeometry.basis'),
    },
    resolution: {
      level: asEnum(resolution.level, RESOLUTION_LEVELS, 'resolution.level') as ResolutionLevel,
      selectedFactIds: asStringArray(resolution.selectedFactIds, 'resolution.selectedFactIds'),
      reasonForWriting: asNullableString(resolution.reasonForWriting, 'resolution.reasonForWriting'),
      whyNow: asNullableString(resolution.whyNow, 'resolution.whyNow'),
      prohibitedAssumptions: resolution.prohibitedAssumptions === undefined
        ? []
        : asStringArray(resolution.prohibitedAssumptions, 'resolution.prohibitedAssumptions'),
    },
    resolutionUpgrade: {
      obtainableFact: asOptionalNullableString(
        resolutionUpgrade?.obtainableFact,
        'resolutionUpgrade.obtainableFact',
      ),
      whyItWouldRaiseResolution: asOptionalNullableString(
        resolutionUpgrade?.whyItWouldRaiseResolution,
        'resolutionUpgrade.whyItWouldRaiseResolution',
      ),
      howToObtainWithoutGuessing: asOptionalNullableString(
        resolutionUpgrade?.howToObtainWithoutGuessing,
        'resolutionUpgrade.howToObtainWithoutGuessing',
      ),
    },
    companyContextProvenance: {
      origin: companyContextProvenance
        ? asEnum(
          companyContextProvenance.origin,
          ['fresh', 'reused_within_workspace'] as const,
          'companyContextProvenance.origin',
        )
        : 'fresh',
      sourceDraftingItemId: asOptionalNullableString(
        companyContextProvenance?.sourceDraftingItemId,
        'companyContextProvenance.sourceDraftingItemId',
      ),
      resolvedDomain: asOptionalNullableString(
        companyContextProvenance?.resolvedDomain,
        'companyContextProvenance.resolvedDomain',
      ),
      validUntil: asOptionalNullableString(
        companyContextProvenance?.validUntil,
        'companyContextProvenance.validUntil',
      ),
    },
    sources,
  };
}

function parseChecks(value: unknown, path: string): DraftOutputChecks {
  if (!isRecord(value)) throw new Error(`Invalid checks at ${path}`);
  return {
    reasonClearInFirstThreeSentences: asBoolean(
      value.reasonClearInFirstThreeSentences,
      `${path}.reasonClearInFirstThreeSentences`,
    ),
    oneIdea: asBoolean(value.oneIdea, `${path}.oneIdea`),
    oneReason: asBoolean(value.oneReason, `${path}.oneReason`),
    oneAsk: asBoolean(value.oneAsk, `${path}.oneAsk`),
    noInventedSpecifics: asBoolean(value.noInventedSpecifics, `${path}.noInventedSpecifics`),
    noVendorPattern: asBoolean(value.noVendorPattern, `${path}.noVendorPattern`),
    noEmDash: asBoolean(value.noEmDash, `${path}.noEmDash`),
    noMarketingFormatting: asBoolean(value.noMarketingFormatting, `${path}.noMarketingFormatting`),
    senderFactsFromProvidedSourcesOnly: asBoolean(
      value.senderFactsFromProvidedSourcesOnly,
      `${path}.senderFactsFromProvidedSourcesOnly`,
    ),
    // Added after drafts were already persisted, so these stay optional: an
    // absent value reads as "not attested" rather than failing the parse.
    noStackedClauses: asAttestation(value.noStackedClauses),
    everySentenceParsesOnFirstRead: asAttestation(value.everySentenceParsesOnFirstRead),
  };
}

/** Optional boolean attestation — defaults to true so older payloads still parse. */
function asAttestation(value: unknown): boolean {
  return typeof value === 'boolean' ? value : true;
}

const CLAIM_TYPES = ['prospect_fact', 'sender_fact', 'relationship_fact'] as const;

/** Models sometimes confuse claimType with resolutionUsed (e.g. role_segment). */
function coerceClaimType(value: unknown): (typeof CLAIM_TYPES)[number] {
  if (typeof value === 'string' && (CLAIM_TYPES as readonly string[]).includes(value)) {
    return value as (typeof CLAIM_TYPES)[number];
  }
  return 'prospect_fact';
}

function parseClaimLedger(value: unknown, path: string): DraftClaimLedgerEntry[] {
  if (!Array.isArray(value)) throw new Error(`Invalid claimLedger at ${path}`);
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Invalid claim at ${path}[${index}]`);
    return {
      exactText: asString(item.exactText, `${path}[${index}].exactText`),
      factIds: asStringArray(item.factIds, `${path}[${index}].factIds`),
      claimType: coerceClaimType(item.claimType),
      temporalFraming: asEnum(
        item.temporalFraming,
        [
          'none', 'anticipatory', 'active', 'retrospective',
          'current_context', 'historical_context', 'timeless',
        ] as const,
        `${path}[${index}].temporalFraming`,
      ),
    };
  });
}

/** Parse and type-check a report_draft_output tool payload. */
export function parseDraftOutput(raw: unknown): DraftOutput {
  if (!isRecord(raw)) throw new Error('Draft output must be an object');
  const writerLevels = ['person', 'company', 'role_segment', 'moment', 'structure'] as const;
  return {
    schemaVersion: '1',
    subject: asString(raw.subject, 'subject'),
    bodyText: asString(raw.bodyText, 'bodyText'),
    resolutionUsed: asEnum(raw.resolutionUsed, writerLevels, 'resolutionUsed') as WriterResolutionLevel,
    usedFactIds: asStringArray(raw.usedFactIds, 'usedFactIds'),
    claimLedger: parseClaimLedger(raw.claimLedger, 'claimLedger'),
    askForm: asEnum(raw.askForm, ASK_FORMS, 'askForm') as AskForm,
    checks: parseChecks(raw.checks, 'checks'),
  };
}
