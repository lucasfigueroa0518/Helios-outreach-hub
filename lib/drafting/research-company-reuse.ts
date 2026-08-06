import type {
  DraftingResearchPacket,
  InputSnapshot,
  ResearchFact,
  ResearchSource,
  ReusableCompanyResearchContext,
} from '@/lib/drafting/types';
import {
  assessResearchTimeliness,
  RESEARCH_PACKET_MAX_AGE_MS,
} from '@/lib/drafting/temporal-policy';
import { normalizeEmail, normalizeRequiredField } from '@/lib/drafting/normalize';

const COMPANY_FACT_LIMIT = 3;
const ROLE_FACT_LIMIT = 2;

function isCompanySafe(
  sourceIds: string[],
  sourcesById: ReadonlyMap<string, ResearchSource>,
): boolean {
  return sourceIds.length > 0
    && sourceIds.every((sourceId) => sourcesById.get(sourceId)?.bindsPerson === false);
}

function reusableFacts(
  facts: ResearchFact[],
  sourcesById: ReadonlyMap<string, ResearchSource>,
  limit: number,
): ResearchFact[] {
  return facts
    .filter((fact) =>
      fact.confidence === 'supported'
      && fact.weight !== 'discard'
      && isCompanySafe(fact.sourceIds, sourcesById))
    .slice(0, limit);
}

export function buildReusableCompanyResearchContext(input: {
  sourceDraftingItemId: string;
  company: string;
  packet: DraftingResearchPacket;
  now?: Date;
}): ReusableCompanyResearchContext | null {
  const sourcesById = new Map(input.packet.sources.map((source) => [source.id, source]));
  const now = input.now ?? new Date();
  const reusableFactIds = [
    ...input.packet.companyFacts,
    ...input.packet.roleSegmentFacts,
  ].map((fact) => fact.id);
  const audit = assessResearchTimeliness({
    ...input.packet,
    resolution: {
      ...input.packet.resolution,
      selectedFactIds: reusableFactIds,
    },
  }, now);
  if (audit.status === 'blocked') return null;
  const blockedFactIds = new Set(audit.blockedFactIds);
  const companyFacts = reusableFacts(
    input.packet.companyFacts.filter((fact) => !blockedFactIds.has(fact.id)),
    sourcesById,
    COMPANY_FACT_LIMIT,
  );
  const roleSegmentFacts = reusableFacts(
    input.packet.roleSegmentFacts.filter((fact) => !blockedFactIds.has(fact.id)),
    sourcesById,
    ROLE_FACT_LIMIT,
  );
  const referencedSourceIds = new Set([
    ...companyFacts.flatMap((fact) => fact.sourceIds),
    ...roleSegmentFacts.flatMap((fact) => fact.sourceIds),
  ]);
  const sources = input.packet.sources.filter((source) => referencedSourceIds.has(source.id));

  if (!companyFacts.length && !roleSegmentFacts.length) return null;

  const packetAsOf = Date.parse(input.packet.asOf);
  const validUntilMs = Number.isFinite(packetAsOf)
    ? Math.min(now.getTime() + RESEARCH_PACKET_MAX_AGE_MS, packetAsOf + RESEARCH_PACKET_MAX_AGE_MS)
    : now.getTime();
  return {
    sourceDraftingItemId: input.sourceDraftingItemId,
    company: input.company,
    validUntil: new Date(validUntilMs).toISOString(),
    prospectWorld: {
      pressures: [],
    },
    companyFacts,
    roleSegmentFacts,
    sources,
  };
}

/**
 * Skip Sonnet research for sibling leads when company context is reusable and
 * enrichment already supplied a complete identity (name/email/company/title).
 */
export function canSkipSiblingResearch(
  snapshot: InputSnapshot,
  reusable: ReusableCompanyResearchContext | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!reusable) return false;
  const validUntilMs = Date.parse(reusable.validUntil);
  if (!Number.isFinite(validUntilMs) || validUntilMs <= now.getTime()) return false;
  if (!reusable.companyFacts.length && !reusable.roleSegmentFacts.length) return false;
  const lead = snapshot.lead;
  return Boolean(
    normalizeRequiredField(lead.fullName)
    && normalizeEmail(lead.email)
    && normalizeRequiredField(lead.company)
    && normalizeRequiredField(lead.title),
  );
}

/**
 * Assemble a write-ready packet from reused company evidence + sheet identity.
 * Person facts stay empty — siblings do not re-spend on person freshness.
 */
export function assemblePacketFromReusableContext(input: {
  inputSnapshot: InputSnapshot;
  reusable: ReusableCompanyResearchContext;
  now?: Date;
}): DraftingResearchPacket {
  const now = (input.now ?? new Date()).toISOString();
  const lead = input.inputSnapshot.lead;
  const company = normalizeRequiredField(lead.company) ?? input.reusable.company;
  const fullName = normalizeRequiredField(lead.fullName) ?? 'Lead';
  const title = normalizeRequiredField(lead.title) ?? 'an executive';
  const companyFacts = input.reusable.companyFacts;
  const roleSegmentFacts = input.reusable.roleSegmentFacts;
  const selectedFactIds = [
    ...companyFacts.map((fact) => fact.id),
    ...roleSegmentFacts.map((fact) => fact.id),
  ].slice(0, 5);
  const resolutionLevel = companyFacts.length > 0 ? 'company' : 'role_segment';
  const anchorClaim = companyFacts[0]?.normalizedClaim
    ?? roleSegmentFacts[0]?.normalizedClaim
    ?? `Relevant context at ${company}`;

  return {
    schemaVersion: '2',
    asOf: now,
    leadIdentity: {
      classification: 'usable_at_lower_resolution',
      suppliedSummary: `${fullName} at ${company}`,
      currentSummary: `${fullName} serves as ${title} at ${company}`,
      conflictSummary: null,
      supportingSourceIds: [],
    },
    freshness: {
      employer: { status: 'current', sourceIds: [], summary: `Current employer ${company}` },
      title: { status: 'current', sourceIds: [], summary: title },
      location: {
        status: lead.workLocation ? 'recent' : 'undated',
        sourceIds: [],
        summary: lead.workLocation ?? null,
      },
    },
    prospectWorld: {
      roleReality: `${title} responsibilities at ${company}`,
      pressures: input.reusable.prospectWorld.pressures,
      contactNorm: {
        form: 'reply',
        statement: 'Professional email reply is appropriate',
        sourceIds: [],
        confidence: 'supported',
      },
      registerNotes: ['Assembled from workspace company research reuse — no sibling Sonnet research'],
      commonVendorPatterns: [],
    },
    personFacts: [],
    companyFacts,
    roleSegmentFacts,
    structuralRelation: {
      relation: 'complementary',
      recipientConstraint: null,
      embarkCapabilityId: 'financial_reporting_advisory',
      supportedReason: 'Reused company context from a sibling lead in this workspace',
      tensionToName: null,
      sourceIds: selectedFactIds.slice(0, 1),
    },
    statusGeometry: {
      classification: 'peer',
      safePosture: 'Peer professional outreach',
      basis: 'Sheet identity plus reused company evidence',
    },
    resolution: {
      level: resolutionLevel,
      selectedFactIds,
      reasonForWriting: anchorClaim,
      whyNow: null,
      prohibitedAssumptions: [
        'Do not invent person-specific news for this sibling lead',
      ],
    },
    resolutionUpgrade: {
      obtainableFact: null,
      whyItWouldRaiseResolution: null,
      howToObtainWithoutGuessing: null,
    },
    companyContextProvenance: {
      origin: 'reused_within_workspace',
      sourceDraftingItemId: input.reusable.sourceDraftingItemId,
      resolvedDomain: null,
      validUntil: input.reusable.validUntil,
    },
    sources: input.reusable.sources,
  };
}
