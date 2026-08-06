/**
 * Research → write reconciliation.
 *
 * Product rule: never fail closed on packet quality. Prefer a thinner, true
 * brief (even zero personalization) over blocking the draft. Unresolvable or
 * unreliable material is discarded; identity/resolution mismatches are
 * downgraded. Telemetry records every adjustment so research can be improved.
 */

import { CANONICAL_CAPABILITY_IDS } from '@/lib/drafting/types';
import type {
  DraftingResearchPacket,
  ResearchFact,
  ResearchSource,
  ResolutionLevel,
} from '@/lib/drafting/types';
import {
  assessResearchTimeliness,
  type ResearchTimelinessAudit,
  type TemporalFactAudit,
} from '@/lib/drafting/temporal-policy';

export type AdversarialReconcileVerdict = {
  claimId: string;
  decision: 'keep' | 'drop';
  durationSupported: boolean;
};

const ADVERSARIAL_DURATION_OVERRIDE_CODES = new Set([
  'UNSUPPORTED_EXPLICIT_DURATION',
  'UNSUPPORTED_EVENT_END',
  'INVALID_RELEVANCE_WINDOW',
  'EVENT_DURATION_UNKNOWN',
  'CURRENT_STATE_WITHOUT_DATE',
]);

export type ResearchReconcileAction = {
  code: string;
  action: 'dropped' | 'downgraded' | 'cleared' | 'normalized';
  detail: string;
};

export type ResearchReconcileResult = {
  packet: DraftingResearchPacket;
  actions: ResearchReconcileAction[];
  temporalAudit: ResearchTimelinessAudit;
  /** True when the brief is empty/minimal — research should be strengthened later. */
  needsResearchUpgrade: boolean;
  /** When true, live write must not run — no usable personalization facts survived reconcile. */
  writeBlocked: boolean;
};

export type ResearchReconcileOptions = {
  allowedCapabilityIds?: readonly string[];
  maxSelectedFacts?: number;
  now?: Date;
  /** Haiku adversarial keep+duration verdicts — honor over strict temporal metadata gaps. */
  adversarialVerdicts?: readonly AdversarialReconcileVerdict[];
};

/**
 * Current triggers may reach the writer only after adversarial QA actually ran.
 * A skipped/failed QA pass degrades safely to non-urgent context.
 */
export function reconcileResearchPacketAfterAdversarialQa(
  packet: DraftingResearchPacket,
  adversarialSkipped: boolean,
  options: ResearchReconcileOptions = {},
): ResearchReconcileResult {
  const reconcileOptions: ResearchReconcileOptions = adversarialSkipped
    ? { ...options, adversarialVerdicts: undefined }
    : options;
  let reconciled = reconcileResearchPacketForWrite(packet, reconcileOptions);
  if (adversarialSkipped && reconciled.temporalAudit.currentTriggerFactIds.length > 0) {
    const disabledTriggers = new Set(reconciled.temporalAudit.currentTriggerFactIds);
    reconciled = reconcileResearchPacketForWrite({
      ...reconciled.packet,
      resolution: {
        ...reconciled.packet.resolution,
        selectedFactIds: reconciled.packet.resolution.selectedFactIds.filter(
          (factId) => !disabledTriggers.has(factId),
        ),
        whyNow: null,
      },
    }, reconcileOptions);
    reconciled.actions.unshift({
      code: 'ADVERSARIAL_QA_REQUIRED_FOR_CURRENT_TRIGGER',
      action: 'dropped',
      detail: [...disabledTriggers].join(', '),
    });
  }
  return reconciled;
}

const LOW_TRUST_TIERS = new Set(['low']);

function buildAdversarialDurationVerifiedFactIds(
  verdicts: readonly AdversarialReconcileVerdict[] | undefined,
): Set<string> {
  const ids = new Set<string>();
  if (!verdicts) return ids;
  for (const verdict of verdicts) {
    if (verdict.decision !== 'keep' || !verdict.durationSupported) continue;
    const match = /^fact:(.+)$/.exec(verdict.claimId);
    if (match) ids.add(match[1]);
  }
  return ids;
}

function adversarialOverridesTemporalBlock(temporal: TemporalFactAudit): boolean {
  if (temporal.disposition !== 'blocked' || temporal.codes.length === 0) return false;
  return temporal.codes.every((code) => ADVERSARIAL_DURATION_OVERRIDE_CODES.has(code));
}

function allFacts(packet: DraftingResearchPacket): ResearchFact[] {
  return [
    ...packet.personFacts,
    ...packet.companyFacts,
    ...packet.roleSegmentFacts,
  ];
}

function factById(packet: DraftingResearchPacket): Map<string, ResearchFact> {
  return new Map(allFacts(packet).map((fact) => [fact.id, fact]));
}

function sourceById(sources: readonly ResearchSource[]): Map<string, ResearchSource> {
  return new Map(sources.map((source) => [source.id, source]));
}

/**
 * Remove claims deterministic reconciliation must drop regardless of an
 * adversarial answer. Temporal uncertainty stays intact because QA may supply
 * the missing duration support.
 */
export function prefilterResearchPacketForAdversarial(
  packet: DraftingResearchPacket,
): { packet: DraftingResearchPacket; actions: ResearchReconcileAction[] } {
  const actions: ResearchReconcileAction[] = [];
  const facts = factById(packet);
  const personFactIds = new Set(packet.personFacts.map((fact) => fact.id));
  const usableSourceIds = new Set(
    packet.sources
      .filter((source) =>
        /^https?:\/\//i.test(source.url)
        && source.quote.trim().length > 0
        && !LOW_TRUST_TIERS.has(source.trustTier),
      )
      .map((source) => source.id),
  );
  const hasUsableSource = (sourceIds: readonly string[]) =>
    sourceIds.some((sourceId) => usableSourceIds.has(sourceId));

  const selectedFactIds = packet.resolution.selectedFactIds.filter((factId) => {
    const fact = facts.get(factId);
    let code: string | null = null;
    if (!fact) code = 'PREFILTER_UNKNOWN_SELECTED_FACT';
    else if (
      personFactIds.has(factId)
      && packet.leadIdentity.classification !== 'verified'
    ) code = 'PREFILTER_UNVERIFIED_PERSON_FACT';
    else if (!fact.quote.trim()) code = 'PREFILTER_EMPTY_FACT_QUOTE';
    else if (fact.confidence !== 'supported') code = 'PREFILTER_UNSUPPORTED_FACT';
    else if (fact.weight === 'discard') code = 'PREFILTER_DISCARDED_FACT';
    else if (!hasUsableSource(fact.sourceIds)) code = 'PREFILTER_FACT_WITHOUT_USABLE_SOURCE';
    if (!code) return true;
    actions.push({ code, action: 'dropped', detail: factId });
    return false;
  });

  const pressures = packet.prospectWorld.pressures.filter((pressure, index) => {
    const keep = pressure.statement.trim().length > 0
      && pressure.confidence === 'supported'
      && hasUsableSource(pressure.sourceIds);
    if (!keep) {
      actions.push({
        code: 'PREFILTER_UNWRITABLE_PRESSURE',
        action: 'dropped',
        detail: `pressure:${index}`,
      });
    }
    return keep;
  });
  const contactNorm = packet.prospectWorld.contactNorm;
  const keepContactNorm = contactNorm.statement.trim().length > 0
    && contactNorm.confidence === 'supported'
    && hasUsableSource(contactNorm.sourceIds);
  if (!keepContactNorm && contactNorm.statement.trim()) {
    actions.push({
      code: 'PREFILTER_UNWRITABLE_CONTACT_NORM',
      action: 'dropped',
      detail: 'contactNorm',
    });
  }

  return {
    actions,
    packet: {
      ...packet,
      leadIdentity: {
        ...packet.leadIdentity,
        supportingSourceIds: packet.leadIdentity.supportingSourceIds.filter(
          (sourceId) => usableSourceIds.has(sourceId),
        ),
      },
      prospectWorld: {
        ...packet.prospectWorld,
        pressures,
        contactNorm: keepContactNorm
          ? contactNorm
          : { ...contactNorm, statement: '', sourceIds: [], confidence: 'tentative' },
      },
      resolution: {
        ...packet.resolution,
        selectedFactIds,
      },
    },
  };
}

function expandSourceIds(
  ids: string[],
  sourceIds: Set<string>,
  factSourceIds: Map<string, string[]>,
): { ids: string[]; expanded: string[] } {
  const out: string[] = [];
  const expanded: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (sourceIds.has(id)) {
      if (!seen.has(id)) {
        seen.add(id);
        out.push(id);
      }
      continue;
    }
    const fromFact = factSourceIds.get(id);
    if (!fromFact) continue;
    expanded.push(id);
    for (const sourceId of fromFact) {
      if (!sourceIds.has(sourceId) || seen.has(sourceId)) continue;
      seen.add(sourceId);
      out.push(sourceId);
    }
  }
  return { ids: out, expanded };
}

function identityNeedsDowngrade(packet: DraftingResearchPacket): boolean {
  const { classification, conflictSummary } = packet.leadIdentity;
  return (
    classification === 'ambiguous'
    || classification === 'conflicted'
    || classification === 'not_found'
    || Boolean(conflictSummary?.trim())
  );
}

function pickSafeResolutionLevel(
  packet: DraftingResearchPacket,
  selectedFactIds: string[],
): ResolutionLevel {
  const hasCompany = selectedFactIds.some((id) => packet.companyFacts.some((f) => f.id === id));
  const hasRole = selectedFactIds.some((id) => packet.roleSegmentFacts.some((f) => f.id === id));
  const hasPerson = selectedFactIds.some((id) => packet.personFacts.some((f) => f.id === id));

  if (
    packet.leadIdentity.classification === 'verified'
    && hasPerson
    && !identityNeedsDowngrade(packet)
  ) {
    return 'person';
  }
  if (hasCompany) return 'company';
  if (hasRole) return 'role_segment';
  // Empty brief is fine — writer can draft from lead snapshot alone.
  return 'company';
}

/** Expand fact IDs mistakenly placed in sourceIds arrays. */
export function normalizeSourceIdRefs(packet: DraftingResearchPacket): {
  packet: DraftingResearchPacket;
  actions: ResearchReconcileAction[];
} {
  const actions: ResearchReconcileAction[] = [];
  const sourceIds = new Set(packet.sources.map((source) => source.id));
  const factSourceIds = new Map(
    allFacts(packet).map((fact) => [fact.id, fact.sourceIds] as const),
  );

  const mapIds = (path: string, ids: string[]): string[] => {
    const result = expandSourceIds(ids, sourceIds, factSourceIds);
    if (result.expanded.length) {
      actions.push({
        code: 'FACT_IDS_IN_SOURCE_IDS',
        action: 'normalized',
        detail: `${path}: expanded ${result.expanded.join(', ')} to source ids`,
      });
    }
    const dropped = ids.filter(
      (id) => !sourceIds.has(id) && !factSourceIds.has(id),
    );
    if (dropped.length) {
      actions.push({
        code: 'UNKNOWN_SOURCE_ID',
        action: 'dropped',
        detail: `${path}: dropped unknown ids ${dropped.join(', ')}`,
      });
    }
    return result.ids;
  };

  return {
    actions,
    packet: {
      ...packet,
      leadIdentity: {
        ...packet.leadIdentity,
        supportingSourceIds: mapIds(
          'leadIdentity.supportingSourceIds',
          packet.leadIdentity.supportingSourceIds,
        ),
      },
      prospectWorld: {
        ...packet.prospectWorld,
        pressures: packet.prospectWorld.pressures.map((pressure, index) => ({
          ...pressure,
          sourceIds: mapIds(`pressures[${index}].sourceIds`, pressure.sourceIds),
        })),
        contactNorm: {
          ...packet.prospectWorld.contactNorm,
          sourceIds: mapIds(
            'contactNorm.sourceIds',
            packet.prospectWorld.contactNorm.sourceIds,
          ),
        },
      },
      personFacts: packet.personFacts.map((fact) => ({
        ...fact,
        sourceIds: mapIds(`personFacts.${fact.id}`, fact.sourceIds),
      })),
      companyFacts: packet.companyFacts.map((fact) => ({
        ...fact,
        sourceIds: mapIds(`companyFacts.${fact.id}`, fact.sourceIds),
      })),
      roleSegmentFacts: packet.roleSegmentFacts.map((fact) => ({
        ...fact,
        sourceIds: mapIds(`roleSegmentFacts.${fact.id}`, fact.sourceIds),
      })),
      structuralRelation: {
        ...packet.structuralRelation,
        sourceIds: mapIds(
          'structuralRelation.sourceIds',
          packet.structuralRelation.sourceIds,
        ),
      },
    },
  };
}

/**
 * Reconcile a research packet into a write-safe brief.
 * Always returns a packet suitable for the writer — never blocks drafting.
 */
export function reconcileResearchPacketForWrite(
  input: DraftingResearchPacket,
  options: ResearchReconcileOptions = {},
): ResearchReconcileResult {
  const allowedCapabilityIds = options.allowedCapabilityIds ?? CANONICAL_CAPABILITY_IDS;
  const maxSelectedFacts = options.maxSelectedFacts ?? 8;
  const adversarialDurationVerified = buildAdversarialDurationVerifiedFactIds(
    options.adversarialVerdicts,
  );
  const actions: ResearchReconcileAction[] = [];

  const normalized = normalizeSourceIdRefs(input);
  actions.push(...normalized.actions);
  let packet = normalized.packet;
  const sources = sourceById(packet.sources);

  // Drop unusable source rows from the catalog (facts may lose bindings next).
  const keptSources: ResearchSource[] = [];
  for (const source of packet.sources) {
    if (!/^https?:\/\//i.test(source.url) || !source.quote.trim()) {
      actions.push({
        code: !source.quote.trim() ? 'EMPTY_SOURCE_QUOTE' : 'INVALID_SOURCE_URL',
        action: 'dropped',
        detail: `source ${source.id}`,
      });
      continue;
    }
    keptSources.push(source);
  }
  const keptSourceIds = new Set(keptSources.map((source) => source.id));
  packet = {
    ...packet,
    sources: keptSources,
    leadIdentity: {
      ...packet.leadIdentity,
      supportingSourceIds: packet.leadIdentity.supportingSourceIds.filter((id) =>
        keptSourceIds.has(id),
      ),
    },
    prospectWorld: {
      ...packet.prospectWorld,
      pressures: packet.prospectWorld.pressures.map((pressure) => ({
        ...pressure,
        sourceIds: pressure.sourceIds.filter((id) => keptSourceIds.has(id)),
      })),
      contactNorm: {
        ...packet.prospectWorld.contactNorm,
        sourceIds: packet.prospectWorld.contactNorm.sourceIds.filter((id) =>
          keptSourceIds.has(id),
        ),
      },
    },
    personFacts: packet.personFacts.map((fact) => ({
      ...fact,
      sourceIds: fact.sourceIds.filter((id) => keptSourceIds.has(id)),
    })),
    companyFacts: packet.companyFacts.map((fact) => ({
      ...fact,
      sourceIds: fact.sourceIds.filter((id) => keptSourceIds.has(id)),
    })),
    roleSegmentFacts: packet.roleSegmentFacts.map((fact) => ({
      ...fact,
      sourceIds: fact.sourceIds.filter((id) => keptSourceIds.has(id)),
    })),
    structuralRelation: {
      ...packet.structuralRelation,
      sourceIds: packet.structuralRelation.sourceIds.filter((id) => keptSourceIds.has(id)),
    },
  };

  // Identity reconciliation: discard unverified person claims; keep company/role.
  if (identityNeedsDowngrade(packet)) {
    actions.push({
      code: 'IDENTITY_NOT_WRITABLE',
      action: 'downgraded',
      detail: `classification ${packet.leadIdentity.classification} → usable_at_lower_resolution; person claims discarded`,
    });
    packet = {
      ...packet,
      leadIdentity: {
        ...packet.leadIdentity,
        classification: 'usable_at_lower_resolution',
        conflictSummary: null,
      },
    };
  }

  let selectedFactIds = [...packet.resolution.selectedFactIds];
  const initialTemporalAudit = assessResearchTimeliness(packet, options.now);
  const temporalByFactId = new Map(
    initialTemporalAudit.facts.map((fact) => [fact.factId, fact]),
  );
  const normalizeDiscourse = (fact: ResearchFact): ResearchFact => {
    if (!fact.temporal) return fact;
    const audit = temporalByFactId.get(fact.id);
    if (!audit) return fact;
    const expected = audit.lifecycle === 'upcoming'
      ? 'current_trigger'
      : audit.lifecycle === 'ongoing' || audit.lifecycle === 'structural'
        ? 'ongoing'
        : audit.lifecycle === 'evergreen' ? 'timeless' : 'historical_context';
    if (fact.temporal.discourse === expected) return fact;
    actions.push({
      code: 'TEMPORAL_DISCOURSE_NORMALIZED',
      action: 'normalized',
      detail: `${fact.id}: ${fact.temporal.discourse} → ${expected}`,
    });
    return { ...fact, temporal: { ...fact.temporal, discourse: expected } };
  };
  packet = {
    ...packet,
    personFacts: packet.personFacts.map(normalizeDiscourse),
    companyFacts: packet.companyFacts.map(normalizeDiscourse),
    roleSegmentFacts: packet.roleSegmentFacts.map(normalizeDiscourse),
  };
  const facts = factById(packet);

  // Drop person-selected facts unless identity is verified.
  if (packet.leadIdentity.classification !== 'verified') {
    const personSelected = selectedFactIds.filter((id) =>
      packet.personFacts.some((fact) => fact.id === id),
    );
    if (personSelected.length) {
      actions.push({
        code: 'PERSON_FACT_WITHOUT_VERIFIED_IDENTITY',
        action: 'dropped',
        detail: personSelected.join(', '),
      });
      selectedFactIds = selectedFactIds.filter((id) => !personSelected.includes(id));
    }
  }

  if (
    packet.resolution.level === 'person'
    && packet.leadIdentity.classification !== 'verified'
  ) {
    actions.push({
      code: 'RESOLUTION_EXCEEDS_IDENTITY',
      action: 'downgraded',
      detail: 'person → company/role_segment',
    });
  }

  if (packet.resolution.level === 'true_zero') {
    actions.push({
      code: 'TRUE_ZERO_NOT_WRITABLE',
      action: 'downgraded',
      detail: 'true_zero → company with empty/minimal brief; research upgrade needed',
    });
  }

  // Evidence quality: keep only selected facts that are honestly usable.
  const usableSelected: string[] = [];
  for (const factId of selectedFactIds) {
    const fact = facts.get(factId);
    if (!fact) {
      actions.push({
        code: 'UNKNOWN_SELECTED_FACT',
        action: 'dropped',
        detail: factId,
      });
      continue;
    }
    if (!fact.quote.trim()) {
      actions.push({
        code: 'EMPTY_FACT_QUOTE',
        action: 'dropped',
        detail: factId,
      });
      continue;
    }
    if (fact.sourceIds.length === 0) {
      actions.push({
        code: 'SELECTED_FACT_WITHOUT_SOURCES',
        action: 'dropped',
        detail: factId,
      });
      continue;
    }
    const bound = fact.sourceIds
      .map((id) => sources.get(id))
      .filter((source): source is ResearchSource => source != null && keptSourceIds.has(source.id));
    if (bound.length === 0) {
      actions.push({
        code: 'SELECTED_FACT_WITHOUT_SOURCES',
        action: 'dropped',
        detail: `${factId} (sources removed)`,
      });
      continue;
    }
    if (bound.every((source) => LOW_TRUST_TIERS.has(source.trustTier))) {
      actions.push({
        code: 'LOW_ONLY_ANCHOR',
        action: 'dropped',
        detail: factId,
      });
      continue;
    }
    if (fact.confidence !== 'supported') {
      actions.push({
        code: 'UNSUPPORTED_FACT',
        action: 'dropped',
        detail: `${factId} (${fact.confidence})`,
      });
      continue;
    }
    const temporal = temporalByFactId.get(factId);
    if (temporal?.disposition === 'blocked') {
      if (
        adversarialDurationVerified.has(factId)
        && adversarialOverridesTemporalBlock(temporal)
      ) {
        actions.push({
          code: 'ADVERSARIAL_DURATION_OVERRIDE',
          action: 'normalized',
          detail: `${factId} (${temporal.codes.join(', ')})`,
        });
        usableSelected.push(factId);
        continue;
      }
      actions.push({
        code: 'TEMPORALLY_UNSAFE_FACT',
        action: 'dropped',
        detail: `${factId} (${temporal.codes.join(', ')})`,
      });
      continue;
    }
    usableSelected.push(factId);
  }
  selectedFactIds = usableSelected;

  const selectionTemporalAudit = assessResearchTimeliness(
    { ...packet, resolution: { ...packet.resolution, selectedFactIds } },
    options.now,
  );
  const selectionTemporalByFactId = new Map(
    selectionTemporalAudit.facts.map((fact) => [fact.factId, fact]),
  );

  if (selectedFactIds.length > maxSelectedFacts) {
    actions.push({
      code: 'TOO_MANY_SELECTED_FACTS',
      action: 'dropped',
      detail: `trimmed ${selectedFactIds.length - maxSelectedFacts} facts`,
    });
    selectedFactIds = selectedFactIds.slice(0, maxSelectedFacts);
  }

  let whyNow = packet.resolution.whyNow;
  if (whyNow?.trim()) {
    const currentTrigger = selectedFactIds.some(
      (id) => selectionTemporalByFactId.get(id)?.disposition === 'current_trigger',
    );
    if (!currentTrigger) {
      actions.push({
        code: 'NO_CURRENT_TRIGGER_FOR_WHY_NOW',
        action: 'cleared',
        detail: 'whyNow lacked a recent or not-yet-ended dated event',
      });
      whyNow = null;
    }
  }

  let embarkCapabilityId = packet.structuralRelation.embarkCapabilityId;
  if (embarkCapabilityId && !allowedCapabilityIds.includes(embarkCapabilityId)) {
    actions.push({
      code: 'UNKNOWN_CAPABILITY_ID',
      action: 'cleared',
      detail: embarkCapabilityId,
    });
    embarkCapabilityId = null;
  }

  // Strip research prose that invents Embark industry/track-record gaps or
  // coaches the writer into performative humility.
  const structuralNoise = /track record|no demonstrated|not among Embark|named core industries|hospitality-specific|lacks? (relevant )?experience|industry-gap|industry gap|without .{0,40}expertise/i;
  let tensionToName = packet.structuralRelation.tensionToName;
  let supportedReason = packet.structuralRelation.supportedReason;
  let recipientConstraint = packet.structuralRelation.recipientConstraint;
  let relation = packet.structuralRelation.relation;

  if (tensionToName && structuralNoise.test(tensionToName)) {
    actions.push({
      code: 'INDUSTRY_GAP_TENSION_CLEARED',
      action: 'cleared',
      detail: 'tensionToName invented industry/track-record gap',
    });
    tensionToName = null;
    if (relation === 'potential_tension') relation = 'adjacent';
  }
  if (supportedReason && structuralNoise.test(supportedReason)) {
    actions.push({
      code: 'INDUSTRY_GAP_REASON_CLEARED',
      action: 'cleared',
      detail: 'supportedReason invented industry/track-record gap',
    });
    // Keep a short capability-fit stub rather than the self-sabotaging sentence.
    supportedReason = supportedReason
      .split(/even though|although Embark|despite Embark/i)[0]
      ?.trim()
      || null;
    if (supportedReason && structuralNoise.test(supportedReason)) supportedReason = null;
  }
  if (recipientConstraint && structuralNoise.test(recipientConstraint)) {
    actions.push({
      code: 'INDUSTRY_GAP_CONSTRAINT_CLEARED',
      action: 'cleared',
      detail: 'recipientConstraint invented industry/track-record gap',
    });
    recipientConstraint = null;
  }

  const humilityCoach = /\b(i don'?t know|do not know|won'?t guess|will not guess|don'?t presume|do not presume|admit|clueless|uncertain about)\b/i;
  let safePosture = packet.statusGeometry.safePosture?.trim() || 'measured_small_ask';
  if (safePosture.length > 48 || humilityCoach.test(safePosture)) {
    actions.push({
      code: 'SAFE_POSTURE_NORMALIZED',
      action: 'normalized',
      detail: 'safePosture collapsed to short label',
    });
    safePosture = packet.statusGeometry.classification === 'sender_junior'
      || packet.statusGeometry.classification === 'unknown_to_established'
      ? 'junior_to_senior_small_ask'
      : 'measured_small_ask';
  }

  const prohibitedAssumptions = packet.resolution.prohibitedAssumptions
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => {
      if (/^(omit|do not|don't|never)\b/i.test(entry)) return entry.slice(0, 120);
      return `omit: ${entry.slice(0, 110)}`;
    })
    .slice(0, 6);

  // Contact norm: drop if it has no usable sources after cleanup.
  let contactNorm = packet.prospectWorld.contactNorm;
  if (
    contactNorm.form !== 'unknown'
    && contactNorm.sourceIds.length === 0
    && contactNorm.confidence !== 'supported'
  ) {
    // tentative/unknown with no sources — keep statement only if supported; else soften
  }
  if (contactNorm.confidence !== 'supported' || contactNorm.sourceIds.length === 0) {
    if (contactNorm.form !== 'unknown' || contactNorm.statement.trim()) {
      actions.push({
        code: 'CONTACT_NORM_UNRELIABLE',
        action: 'downgraded',
        detail: 'contactNorm → unknown',
      });
    }
    contactNorm = {
      form: 'unknown',
      statement: '',
      sourceIds: [],
      confidence: 'tentative',
    };
  }

  // Pressures: drop unsupported / sourceless.
  const pressures = packet.prospectWorld.pressures.filter((pressure) => {
    if (pressure.confidence !== 'supported') {
      actions.push({
        code: 'PRESSURE_UNRELIABLE',
        action: 'dropped',
        detail: pressure.statement.slice(0, 80),
      });
      return false;
    }
    if (pressure.sourceIds.length === 0) {
      actions.push({
        code: 'PRESSURE_UNRELIABLE',
        action: 'dropped',
        detail: 'supported pressure missing sources',
      });
      return false;
    }
    return true;
  });

  const level = pickSafeResolutionLevel(
    {
      ...packet,
      resolution: { ...packet.resolution, selectedFactIds },
    },
    selectedFactIds,
  );

  const writeBlocked = selectedFactIds.length === 0;
  const needsResearchUpgrade =
    packet.resolution.level === 'true_zero'
    || writeBlocked
    || actions.some((entry) => entry.code === 'TRUE_ZERO_NOT_WRITABLE');

  if (writeBlocked) {
    actions.push({
      code: 'EMPTY_BRIEF_WRITE_BLOCKED',
      action: 'normalized',
      detail: 'write blocked until research yields usable personalization facts',
    });
  }

  packet = {
    ...packet,
    prospectWorld: {
      ...packet.prospectWorld,
      pressures,
      contactNorm,
    },
    statusGeometry: {
      ...packet.statusGeometry,
      safePosture,
    },
    structuralRelation: {
      ...packet.structuralRelation,
      relation,
      embarkCapabilityId,
      tensionToName,
      supportedReason,
      recipientConstraint,
    },
    resolution: {
      ...packet.resolution,
      level,
      selectedFactIds,
      whyNow,
      prohibitedAssumptions,
    },
  };

  const temporalAudit = assessResearchTimeliness(packet, options.now);
  return { packet, actions, temporalAudit, needsResearchUpgrade, writeBlocked };
}
