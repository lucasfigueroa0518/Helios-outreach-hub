/**
 * Diagnostic research-packet validation.
 *
 * Write-path policy lives in research-reconcile.ts: unreliable material is
 * stripped/downgraded and drafting continues. This module remains for tests
 * and offline inspection of raw packet shape/evidence issues.
 */

import type {
  DraftingResearchPacket,
  ResearchFact,
  ResearchSource,
  SourceFamily,
} from '@/lib/drafting/types';

export type ResearchValidationIssue = {
  code: string;
  message: string;
  path?: string;
};

export type ResearchValidationOptions = {
  allowedCapabilityIds: readonly string[];
  requireIndependentSourcesForIdentity?: boolean;
  maxSelectedFacts?: number;
};

const LOW_TRUST_TIERS = new Set(['low']);

function allFacts(packet: DraftingResearchPacket): ResearchFact[] {
  return [
    ...packet.personFacts,
    ...packet.companyFacts,
    ...packet.roleSegmentFacts,
  ];
}

function sourceById(sources: readonly ResearchSource[]): Map<string, ResearchSource> {
  return new Map(sources.map((source) => [source.id, source]));
}

function normalizeFamily(family: SourceFamily): string {
  return family.trim().toLowerCase();
}

function selectedFacts(packet: DraftingResearchPacket): ResearchFact[] {
  const selected = new Set(packet.resolution.selectedFactIds);
  return allFacts(packet).filter((fact) => selected.has(fact.id));
}

function factSources(fact: ResearchFact, sources: Map<string, ResearchSource>): ResearchSource[] {
  return fact.sourceIds
    .map((id) => sources.get(id))
    .filter((source): source is ResearchSource => source != null);
}

function hasUsableDate(value: string | null | undefined): boolean {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function validateSourceReferences(
  packet: DraftingResearchPacket,
  issues: ResearchValidationIssue[],
): Map<string, ResearchSource> {
  const sources = sourceById(packet.sources);
  const referencedIds = new Set<string>();

  for (const sourceId of packet.leadIdentity.supportingSourceIds) referencedIds.add(sourceId);
  for (const sourceId of packet.structuralRelation.sourceIds) referencedIds.add(sourceId);
  for (const sourceId of packet.prospectWorld.contactNorm.sourceIds) referencedIds.add(sourceId);
  for (const statement of packet.prospectWorld.pressures) {
    for (const sourceId of statement.sourceIds) referencedIds.add(sourceId);
  }
  for (const fact of allFacts(packet)) {
    for (const sourceId of fact.sourceIds) referencedIds.add(sourceId);
  }

  for (const sourceId of referencedIds) {
    if (!sources.has(sourceId)) {
      issues.push({
        code: 'UNKNOWN_SOURCE_ID',
        message: `Referenced source ID does not exist: ${sourceId}`,
        path: `sources.${sourceId}`,
      });
    }
  }

  for (const source of packet.sources) {
    if (!/^https?:\/\//i.test(source.url)) {
      issues.push({
        code: 'INVALID_SOURCE_URL',
        message: `Source URL must be HTTP(S): ${source.id}`,
        path: `sources.${source.id}.url`,
      });
    }
    if (!source.quote.trim()) {
      issues.push({
        code: 'EMPTY_SOURCE_QUOTE',
        message: `Source quote is empty: ${source.id}`,
        path: `sources.${source.id}.quote`,
      });
    }
  }

  return sources;
}

function validateSelectedFacts(
  packet: DraftingResearchPacket,
  sources: Map<string, ResearchSource>,
  issues: ResearchValidationIssue[],
): void {
  for (const factId of packet.resolution.selectedFactIds) {
    const fact = allFacts(packet).find((entry) => entry.id === factId);
    if (!fact) {
      issues.push({
        code: 'UNKNOWN_SELECTED_FACT',
        message: `Selected fact ID does not exist: ${factId}`,
        path: `resolution.selectedFactIds.${factId}`,
      });
      continue;
    }
    if (fact.sourceIds.length === 0) {
      issues.push({
        code: 'SELECTED_FACT_WITHOUT_SOURCES',
        message: `Selected fact has no sources: ${factId}`,
        path: `facts.${factId}.sourceIds`,
      });
    }
    if (!fact.quote.trim()) {
      issues.push({
        code: 'EMPTY_FACT_QUOTE',
        message: `Selected fact quote is empty: ${factId}`,
        path: `facts.${factId}.quote`,
      });
    }
    const boundSources = factSources(fact, sources);
    if (boundSources.length === 0) {
      continue;
    }
    if (boundSources.every((source) => LOW_TRUST_TIERS.has(source.trustTier))) {
      issues.push({
        code: 'LOW_ONLY_ANCHOR',
        message: `Selected fact relies only on low-trust sources: ${factId}`,
        path: `facts.${factId}`,
      });
    }
  }
}

function validateCapabilityId(
  packet: DraftingResearchPacket,
  allowedCapabilityIds: readonly string[],
  issues: ResearchValidationIssue[],
): void {
  const capabilityId = packet.structuralRelation.embarkCapabilityId;
  if (!capabilityId) return;
  if (!allowedCapabilityIds.includes(capabilityId)) {
    issues.push({
      code: 'UNKNOWN_CAPABILITY_ID',
      message: `Embark capability ID is not in the canonical catalog: ${capabilityId}`,
      path: 'structuralRelation.embarkCapabilityId',
    });
  }
}

function validateWhyNow(
  packet: DraftingResearchPacket,
  sources: Map<string, ResearchSource>,
  issues: ResearchValidationIssue[],
): void {
  if (!packet.resolution.whyNow?.trim()) return;

  const anchorFacts = selectedFacts(packet).filter((fact) => fact.weight === 'anchor');
  const datedAnchor = anchorFacts.some((fact) => {
    if (fact.freshness !== 'undated') return true;
    return factSources(fact, sources).some((source) => hasUsableDate(source.publishedOrUpdated));
  });

  if (!datedAnchor) {
    issues.push({
      code: 'UNDATED_WHY_NOW',
      message: 'Why-now claim lacks usable dated anchor evidence',
      path: 'resolution.whyNow',
    });
  }
}

function validateIndependence(
  packet: DraftingResearchPacket,
  sources: Map<string, ResearchSource>,
  options: ResearchValidationOptions,
  issues: ResearchValidationIssue[],
): void {
  if (!options.requireIndependentSourcesForIdentity) return;
  if (packet.leadIdentity.classification !== 'verified') return;

  const families = packet.leadIdentity.supportingSourceIds
    .map((id) => sources.get(id))
    .filter((source): source is ResearchSource => source != null)
    .map((source) => normalizeFamily(source.family));

  const uniqueFamilies = new Set(families);
  if (uniqueFamilies.size < 2) {
    issues.push({
      code: 'SAME_FAMILY_INDEPENDENCE',
      message: 'Verified identity requires at least two independent source families',
      path: 'leadIdentity.supportingSourceIds',
    });
  }
}

function validatePersonFacts(
  packet: DraftingResearchPacket,
  issues: ResearchValidationIssue[],
): void {
  if (packet.leadIdentity.classification === 'verified') return;
  const selectedPersonFacts = packet.resolution.selectedFactIds.filter((factId) =>
    packet.personFacts.some((fact) => fact.id === factId),
  );
  if (selectedPersonFacts.length > 0) {
    issues.push({
      code: 'PERSON_FACT_WITHOUT_VERIFIED_IDENTITY',
      message: 'Person-specific facts selected without verified identity',
      path: 'resolution.selectedFactIds',
    });
  }
}

function validateResolution(
  packet: DraftingResearchPacket,
  issues: ResearchValidationIssue[],
): void {
  const { classification } = packet.leadIdentity;
  const { level } = packet.resolution;

  if (level === 'person' && classification !== 'verified') {
    issues.push({
      code: 'RESOLUTION_EXCEEDS_IDENTITY',
      message: 'Person resolution requires verified identity',
      path: 'resolution.level',
    });
  }
}

function validateSelectedFactCount(
  packet: DraftingResearchPacket,
  maxSelectedFacts: number,
  issues: ResearchValidationIssue[],
): void {
  if (packet.resolution.selectedFactIds.length > maxSelectedFacts) {
    issues.push({
      code: 'TOO_MANY_SELECTED_FACTS',
      message: `Selected fact count exceeds allowance (${maxSelectedFacts})`,
      path: 'resolution.selectedFactIds',
    });
  }
}

export function validateResearchPacket(
  packet: DraftingResearchPacket,
  options: ResearchValidationOptions,
): ResearchValidationIssue[] {
  const issues: ResearchValidationIssue[] = [];
  const sources = validateSourceReferences(packet, issues);

  validateCapabilityId(packet, options.allowedCapabilityIds, issues);
  validateSelectedFacts(packet, sources, issues);
  validateWhyNow(packet, sources, issues);
  validateIndependence(packet, sources, options, issues);
  validatePersonFacts(packet, issues);
  validateResolution(packet, issues);
  validateSelectedFactCount(packet, options.maxSelectedFacts ?? 8, issues);

  return issues;
}

export function isResearchPacketValid(
  packet: DraftingResearchPacket,
  options: ResearchValidationOptions,
): boolean {
  return validateResearchPacket(packet, options).length === 0;
}
