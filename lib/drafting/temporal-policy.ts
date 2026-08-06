import type {
  DraftClaimLedgerEntry,
  DraftingResearchPacket,
  ResearchFact,
  ResearchSource,
} from '@/lib/drafting/types';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const CLOCK_SKEW_MS = HOUR_MS;

export const TEMPORAL_POLICY_VERSION = 'outreach-timeliness-v2';
export const RESEARCH_PACKET_MAX_AGE_MS = 72 * HOUR_MS;
export const CURRENT_STATE_MAX_SOURCE_AGE_MS = 365 * DAY_MS;

export type TemporalLifecycle =
  | 'upcoming'
  | 'ongoing'
  | 'recently_completed'
  | 'expired'
  | 'structural'
  | 'evergreen';
export type TemporalFraming = DraftClaimLedgerEntry['temporalFraming'];
export type TemporalDisposition =
  | 'current_trigger'
  | 'current_context'
  | 'historical_context'
  | 'timeless_context'
  | 'blocked';
export type TemporalFactAudit = {
  factId: string;
  normalizedClaim: string;
  kind: 'event' | 'current_state' | 'evergreen';
  disposition: TemporalDisposition;
  sourceDate: string | null;
  eventStart: string | null;
  eventEnd: string | null;
  relevanceEnd: string | null;
  lifecycle: TemporalLifecycle;
  durationBasis: NonNullable<ResearchFact['temporal']>['durationBasis'] | 'invalid';
  permittedFraming: TemporalFraming[];
  codes: string[];
};
export type ResearchTimelinessAudit = {
  policyVersion: typeof TEMPORAL_POLICY_VERSION;
  auditedAt: string;
  packetAsOf: string;
  status: 'verified' | 'context_only' | 'blocked';
  packetAgeMs: number | null;
  currentTriggerFactIds: string[];
  blockedFactIds: string[];
  codes: string[];
  facts: TemporalFactAudit[];
};
export type DraftTimelinessFinding = { code: string; message: string; matchedText: string };
export type DraftTemporalGrounding = {
  usedFactIds: string[];
  claimLedger: DraftClaimLedgerEntry[];
  prospectTerms?: string[];
};

const EVENT_LANGUAGE =
  /\b(appointed|appointment|joined|joins|promoted|promotion|named|new role|announced|launch(?:ed)?|opening|opened|expansion|acquired|acquisition|merger|world cup|olympics?|conference|summit|deadline|go-live)\b/i;
const CURRENT_STATE_LANGUAGE =
  /\b(currently|serves as|is the|leads?|oversees?|operates?|owns?|employs?|headquartered|portfolio)\b/i;
const ACTIVE_LANGUAGE =
  /\b(currently|ongoing|underway|in progress|in flight|moving forward|execut(?:e|es|ing)|continu(?:e|es|ing)|still active|remains active)\b/i;
const ANTICIPATORY_LANGUAGE =
  /\b(upcoming|ahead of|prepare(?:s|d|ing)? for|will|plan(?:s|ned)? to|scheduled|set to|expected to)\b/i;
const RETROSPECTIVE_LANGUAGE =
  /\b(completed|finished|concluded|wrapped up|following|after|recently|last (?:week|month|quarter|year))\b/i;
const DIRECT_PROSPECT_LANGUAGE = /\b(you|your|your team|the company|the organization)\b/i;
const TEMPORAL_SUBJECT_LANGUAGE =
  /\b(project|implementation|rollout|initiative|transformation|expansion|event|role|facility)\b/i;
const SENDER_LANGUAGE = /\b(I|we|our|Embark)\b/i;
const ASK_LANGUAGE =
  /\b(would you|could we|open to|worth a|interested in|available|time to|conversation|chat|connect|talk(?:ing)?|call|reply|trade notes|compare)\b/i;

const EVENT_DEFAULTS: Record<
  NonNullable<ResearchFact['temporal']>['eventClass'],
  { activeDays: number; postEventDays: number }
> = {
  appointment: { activeDays: 45, postEventDays: 0 },
  short_lived: { activeDays: 7, postEventDays: 0 },
  project: { activeDays: 180, postEventDays: 30 },
  transaction: { activeDays: 180, postEventDays: 30 },
  deadline: { activeDays: 30, postEventDays: 0 },
  conference: { activeDays: 7, postEventDays: 7 },
  announcement: { activeDays: 90, postEventDays: 0 },
  structural: { activeDays: 365, postEventDays: 0 },
  generic: { activeDays: 30, postEventDays: 0 },
};

function parseDate(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
function iso(value: number | null): string | null {
  return value == null ? null : new Date(value).toISOString();
}
function sourceDate(
  fact: ResearchFact,
  sources: ReadonlyMap<string, ResearchSource>,
  nowMs: number,
): number | null {
  const dates = fact.sourceIds.flatMap((id) => {
    const date = parseDate(sources.get(id)?.publishedOrUpdated);
    return date != null && date <= nowMs + CLOCK_SKEW_MS ? [date] : [];
  });
  return dates.length ? Math.max(...dates) : null;
}
function inferKind(fact: ResearchFact): 'event' | 'current_state' | 'evergreen' {
  if (fact.temporal?.kind) return fact.temporal.kind;
  if (EVENT_LANGUAGE.test(fact.normalizedClaim)) return 'event';
  if (CURRENT_STATE_LANGUAGE.test(fact.normalizedClaim)) return 'current_state';
  return 'evergreen';
}
function inferEventClass(
  fact: ResearchFact,
): NonNullable<ResearchFact['temporal']>['eventClass'] {
  if (fact.temporal?.eventClass) return fact.temporal.eventClass;
  const claim = fact.normalizedClaim;
  if (/\b(appointed|appointment|joined|promoted|promotion|named|new role)\b/i.test(claim)) return 'appointment';
  if (/\b(project|implementation|construction|transformation|rollout)\b/i.test(claim)) return 'project';
  if (/\b(acquired|acquisition|merger|transaction|deal)\b/i.test(claim)) return 'transaction';
  if (/\b(deadline|due date|filing date|go-live)\b/i.test(claim)) return 'deadline';
  if (/\b(conference|summit|world cup|olympics?)\b/i.test(claim)) return 'conference';
  if (/\b(announced|launch(?:ed)?|opening|opened)\b/i.test(claim)) return 'announcement';
  return 'generic';
}

function auditFact(
  fact: ResearchFact,
  sources: ReadonlyMap<string, ResearchSource>,
  nowMs: number,
): TemporalFactAudit {
  const publishedMs = sourceDate(fact, sources, nowMs);
  const startMs = parseDate(fact.temporal?.eventStart);
  const endMs = parseDate(fact.temporal?.eventEnd);
  let relevanceMs = parseDate(fact.temporal?.relevanceEnd);
  const kind = inferKind(fact);
  const eventClass = inferEventClass(fact);
  const codes: string[] = [];
  let disposition: TemporalDisposition = 'blocked';
  let lifecycle: TemporalLifecycle = 'expired';
  let durationBasis: TemporalFactAudit['durationBasis'] =
    fact.temporal?.durationBasis ?? 'unknown';
  let permittedFraming: TemporalFraming[] = [];

  if (!fact.temporal) {
    durationBasis = 'invalid';
    codes.push('MISSING_TEMPORAL_CONTRACT');
  } else if (fact.freshness === 'stale' || fact.freshness === 'conflicted') {
    codes.push(`FACT_${fact.freshness.toUpperCase()}`);
  } else if (kind === 'event') {
    const durationIds = fact.temporal.durationSourceIds;
    const evidence = fact.temporal.durationEvidence?.trim() ?? '';
    const bound = durationIds.length > 0
      && durationIds.every((id) => fact.sourceIds.includes(id) && sources.has(id));
    const exactQuote = evidence.length > 0
      && durationIds.some((id) => sources.get(id)?.quote.includes(evidence));
    if (startMs == null && endMs == null) {
      codes.push('EVENT_WITHOUT_DATE');
    } else {
      if (durationBasis === 'explicit_source') {
        if (relevanceMs == null || !bound || !exactQuote) {
          durationBasis = 'invalid';
          codes.push('UNSUPPORTED_EXPLICIT_DURATION');
        }
      } else if (endMs != null) {
        if (!bound || !exactQuote) {
          durationBasis = 'invalid';
          codes.push('UNSUPPORTED_EVENT_END');
        } else {
          durationBasis = 'derived_from_event';
          relevanceMs = endMs + EVENT_DEFAULTS[eventClass].postEventDays * DAY_MS;
        }
      } else if (startMs != null && durationBasis === 'policy_default') {
        relevanceMs = startMs + EVENT_DEFAULTS[eventClass].activeDays * DAY_MS;
      } else {
        durationBasis = 'invalid';
        codes.push('EVENT_DURATION_UNKNOWN');
      }
      if (
        durationBasis === 'invalid'
        || relevanceMs == null
        || (startMs != null && relevanceMs < startMs)
        || (endMs != null && relevanceMs < endMs)
      ) {
        if (relevanceMs != null) codes.push('INVALID_RELEVANCE_WINDOW');
      } else if (startMs != null && nowMs < startMs) {
        lifecycle = nowMs <= relevanceMs ? 'upcoming' : 'expired';
        disposition = lifecycle === 'upcoming' ? 'current_trigger' : 'blocked';
        permittedFraming = lifecycle === 'upcoming' ? ['anticipatory'] : [];
        codes.push(lifecycle === 'upcoming' ? 'EVENT_UPCOMING' : 'EVENT_EXPIRED');
      } else if (endMs != null && nowMs <= endMs) {
        lifecycle = 'ongoing';
        disposition = 'current_trigger';
        permittedFraming = ['active'];
        codes.push('EVENT_ONGOING');
      } else if (endMs == null && nowMs <= relevanceMs) {
        lifecycle = 'ongoing';
        disposition = 'current_trigger';
        permittedFraming = eventClass === 'appointment' ? ['retrospective'] : ['active'];
        codes.push('EVENT_RELEVANT_NOW');
      } else if (nowMs <= relevanceMs) {
        lifecycle = 'recently_completed';
        disposition = 'current_trigger';
        permittedFraming = ['retrospective'];
        codes.push('EVENT_RECENTLY_COMPLETED');
      } else {
        codes.push('EVENT_EXPIRED');
      }
    }
  } else if (kind === 'current_state') {
    lifecycle = 'structural';
    durationBasis = 'unknown';
    if (publishedMs == null) codes.push('CURRENT_STATE_WITHOUT_DATE');
    else if (nowMs - publishedMs > CURRENT_STATE_MAX_SOURCE_AGE_MS) {
      codes.push('CURRENT_STATE_SOURCE_EXPIRED');
    } else {
      disposition = 'current_context';
      permittedFraming = ['current_context'];
      codes.push('CURRENT_STATE_VERIFIED');
    }
  } else {
    lifecycle = 'evergreen';
    disposition = publishedMs == null ? 'timeless_context' : 'current_context';
    permittedFraming = publishedMs == null ? ['timeless'] : ['current_context', 'timeless'];
    codes.push(publishedMs == null ? 'EVERGREEN_UNDATED' : 'EVERGREEN_DATED');
  }

  if (startMs != null && endMs != null && endMs < startMs) {
    disposition = 'blocked';
    lifecycle = 'expired';
    permittedFraming = [];
    codes.push('INVALID_EVENT_WINDOW');
  }
  return {
    factId: fact.id,
    normalizedClaim: fact.normalizedClaim,
    kind,
    disposition,
    sourceDate: iso(publishedMs),
    eventStart: iso(startMs),
    eventEnd: iso(endMs),
    relevanceEnd: iso(relevanceMs),
    lifecycle,
    durationBasis,
    permittedFraming,
    codes,
  };
}

export function assessResearchTimeliness(
  packet: DraftingResearchPacket,
  now: Date = new Date(),
): ResearchTimelinessAudit {
  const nowMs = now.getTime();
  const asOfMs = parseDate(packet.asOf);
  const packetAgeMs = asOfMs == null ? null : nowMs - asOfMs;
  const sources = new Map(packet.sources.map((source) => [source.id, source]));
  const selected = new Set(packet.resolution.selectedFactIds);
  const facts = [...packet.personFacts, ...packet.companyFacts, ...packet.roleSegmentFacts]
    .filter((fact) => selected.has(fact.id))
    .map((fact) => auditFact(fact, sources, nowMs));
  const codes: string[] = [];
  const runtimeVersion: unknown = packet.schemaVersion;
  if (runtimeVersion !== '2') codes.push('LEGACY_PACKET_SCHEMA');
  if (asOfMs == null) codes.push('INVALID_PACKET_AS_OF');
  else if (asOfMs > nowMs + CLOCK_SKEW_MS) codes.push('PACKET_AS_OF_IN_FUTURE');
  else if (packetAgeMs != null && packetAgeMs > RESEARCH_PACKET_MAX_AGE_MS) {
    codes.push('RESEARCH_PACKET_EXPIRED');
  }
  for (const source of packet.sources) {
    const accessed = parseDate(source.accessedAt);
    const published = parseDate(source.publishedOrUpdated);
    if (accessed == null) codes.push('INVALID_SOURCE_ACCESSED_AT');
    else if (accessed > nowMs + CLOCK_SKEW_MS) codes.push('SOURCE_ACCESSED_AT_IN_FUTURE');
    if (source.publishedOrUpdated && published == null) codes.push('INVALID_SOURCE_DATE');
    else if (published != null && published > nowMs + CLOCK_SKEW_MS) codes.push('SOURCE_DATE_IN_FUTURE');
  }
  const blockedFactIds = facts.filter((fact) => fact.disposition === 'blocked').map((fact) => fact.factId);
  const currentTriggerFactIds = facts
    .filter((fact) => fact.disposition === 'current_trigger')
    .map((fact) => fact.factId);
  const packetBlocked = codes.some((code) => [
    'INVALID_PACKET_AS_OF', 'LEGACY_PACKET_SCHEMA', 'PACKET_AS_OF_IN_FUTURE',
    'RESEARCH_PACKET_EXPIRED', 'INVALID_SOURCE_ACCESSED_AT',
    'SOURCE_ACCESSED_AT_IN_FUTURE', 'INVALID_SOURCE_DATE', 'SOURCE_DATE_IN_FUTURE',
  ].includes(code));
  const usable = facts.filter((fact) => fact.disposition !== 'blocked');
  const status = packetBlocked || (facts.length > 0 && usable.length === 0)
    ? 'blocked'
    : currentTriggerFactIds.length ? 'verified' : 'context_only';
  return {
    policyVersion: TEMPORAL_POLICY_VERSION,
    auditedAt: now.toISOString(),
    packetAsOf: packet.asOf,
    status,
    packetAgeMs,
    currentTriggerFactIds,
    blockedFactIds,
    codes: [...new Set([...codes, ...facts.flatMap((fact) => fact.codes)])],
    facts,
  };
}

function completeDraftSentences(body: string): string[] {
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const nonEmpty = lines.map((line, index) => ({ line, index })).filter(({ line }) => line);
  const signoff = lines.findIndex((line) =>
    /^(best|best regards|regards|thanks|thank you|sincerely)[,!]?$/i.test(line));
  const lastNonEmptyIndex = nonEmpty[nonEmpty.length - 1]?.index ?? -1;
  let trailingStart = lastNonEmptyIndex;
  while (trailingStart > 0 && lines[trailingStart - 1] !== '') trailingStart -= 1;
  const trailingBlock = lines.slice(trailingStart, lastNonEmptyIndex + 1);
  const signatureStart = trailingBlock.length >= 2
    && trailingBlock.length <= 3
    && trailingStart > 0
    && lines[trailingStart - 1] === ''
    && /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){0,4}$/u.test(
      trailingBlock[0],
    )
    && trailingBlock.every((line) => line.length <= 80 && !/[.!?]$/.test(line))
    ? trailingStart
    : -1;
  const firstContentIndex = nonEmpty[0]?.index ?? -1;
  return lines.filter((line, index) => {
    if (!line) return false;
    if (
      index === firstContentIndex
      && (
        /^(hi|hello|hey|dear)\b.{0,80}[,:]$/i.test(line)
        || /^[\p{L}\p{M}][\p{L}\p{M}'’.-]*(?:\s+[\p{L}\p{M}][\p{L}\p{M}'’.-]*){0,4}[,:]$/u.test(line)
      )
    ) return false;
    if (signoff >= 0 && index >= signoff) return false;
    return signatureStart < 0 || index < signatureStart;
  }).flatMap((line) => {
    const token = '__DOT__';
    return line
      .replace(/\b(?:U\.S|U\.K|e\.g|i\.e)\.(?=\s+\S)/g, (m) => m.replaceAll('.', token))
      .replace(/\b(?:Inc|Corp|Co|Ltd|Jr|Sr)\.(?=\s+[a-z])/g, (m) => m.replace('.', token))
      .replace(/\b(?:Mr|Mrs|Ms|Dr)\.(?=\s+[A-Z])/g, (m) => m.replace('.', token))
      .replace(/(?<=\d)\.(?=\d)/g, token)
      .replace(/\b[A-Z]\.(?=\s+[A-Z][a-z])/g, (m) => m.replace('.', token))
      .split(/(?<=[.!?])\s+/)
      .map((sentence) => sentence.replaceAll(token, '.').trim())
      .filter(Boolean);
  });
}

/**
 * Reconcile a human-edited body without inventing prospect grounding.
 * Exact unchanged entries survive. New benign prose gets a deterministic
 * no-fact entry; prospect or lifecycle edits stay ungrounded and fail closed.
 */
export function reconcileManualDraftGrounding(
  body: string,
  previous: DraftTemporalGrounding,
): DraftTemporalGrounding {
  const remaining = new Map<string, DraftClaimLedgerEntry[]>();
  for (const entry of previous.claimLedger) {
    const entries = remaining.get(entry.exactText) ?? [];
    entries.push(entry);
    remaining.set(entry.exactText, entries);
  }

  const claimLedger: DraftClaimLedgerEntry[] = [];
  for (const sentence of completeDraftSentences(body)) {
    const exactEntries = remaining.get(sentence);
    const preserved = exactEntries?.shift();
    if (preserved) {
      claimLedger.push(preserved);
      continue;
    }

    const lower = sentence.toLowerCase();
    const isAsk = sentence.endsWith('?') || ASK_LANGUAGE.test(sentence);
    const namesProspect = (previous.prospectTerms ?? []).some((term) =>
      term.trim().length >= 3 && lower.includes(term.trim().toLowerCase()));
    const referencesProspect = namesProspect || DIRECT_PROSPECT_LANGUAGE.test(sentence);
    const usesLifecycleLanguage = ACTIVE_LANGUAGE.test(sentence)
      || ANTICIPATORY_LANGUAGE.test(sentence)
      || RETROSPECTIVE_LANGUAGE.test(sentence);

    if (!isAsk && (referencesProspect || usesLifecycleLanguage)) continue;
    claimLedger.push({
      exactText: sentence,
      factIds: [],
      claimType: !isAsk && SENDER_LANGUAGE.test(sentence)
        ? 'sender_fact'
        : 'relationship_fact',
      temporalFraming: 'none',
    });
  }

  const usedFactIds = [...new Set(
    claimLedger
      .filter((entry) => entry.claimType === 'prospect_fact')
      .flatMap((entry) => entry.factIds),
  )];
  return {
    usedFactIds,
    claimLedger,
    ...(previous.prospectTerms ? { prospectTerms: previous.prospectTerms } : {}),
  };
}

function framingMatches(framing: TemporalFraming, sentence: string): boolean {
  if (framing === 'retrospective' || framing === 'historical_context') {
    return !ACTIVE_LANGUAGE.test(sentence) && !ANTICIPATORY_LANGUAGE.test(sentence);
  }
  if (framing === 'anticipatory') {
    return !ACTIVE_LANGUAGE.test(sentence) && !RETROSPECTIVE_LANGUAGE.test(sentence);
  }
  if (framing === 'active') {
    return !ANTICIPATORY_LANGUAGE.test(sentence) && !RETROSPECTIVE_LANGUAGE.test(sentence);
  }
  if (framing === 'timeless') {
    return !ACTIVE_LANGUAGE.test(sentence)
      && !ANTICIPATORY_LANGUAGE.test(sentence)
      && !RETROSPECTIVE_LANGUAGE.test(sentence);
  }
  return !ANTICIPATORY_LANGUAGE.test(sentence) && !RETROSPECTIVE_LANGUAGE.test(sentence);
}

export function findDraftTimelinessFailures(
  subject: string,
  body: string,
  audit: ResearchTimelinessAudit,
  grounding?: DraftTemporalGrounding,
): DraftTimelinessFinding[] {
  const combined = `${subject}\n${body}`;
  const findings: DraftTimelinessFinding[] = [];
  const nextLedgerStartByText = new Map<string, number>();
  const ledgerBindings = (grounding?.claimLedger ?? []).map((entry) => {
    const from = nextLedgerStartByText.get(entry.exactText) ?? subject.length + 1;
    const start = combined.indexOf(entry.exactText, from);
    if (start >= 0) nextLedgerStartByText.set(entry.exactText, start + entry.exactText.length);
    return { entry, start, end: start < 0 ? -1 : start + entry.exactText.length };
  });
  const highRisk = [
    {
      code: 'UNVERIFIED_NEW_ROLE_LANGUAGE',
      message: 'New-role congratulations require a current, dated appointment trigger.',
      pattern: /\b(?:congratulations|congrats)\b[^.!?\n]{0,100}\b(?:new|recent|appointment|role|promotion|joining)\b/gi,
      qualifies: (fact: TemporalFactAudit) => fact.disposition === 'current_trigger'
        && /\b(appointed|appointment|joined|joins|promoted|promotion|named|new role)\b/i.test(fact.normalizedClaim),
      framing: ['retrospective'],
    },
    {
      code: 'UNVERIFIED_RECENCY_LANGUAGE',
      message: 'Recency wording requires a current, dated trigger.',
      pattern: /\b(?:recently|newly|just announced|just joined|in the past few (?:days|weeks|months))\b/gi,
      qualifies: (fact: TemporalFactAudit) => fact.disposition === 'current_trigger'
        && (fact.lifecycle === 'recently_completed' || fact.codes.includes('EVENT_RELEVANT_NOW')),
      framing: ['retrospective'],
    },
    {
      code: 'UNVERIFIED_FUTURE_EVENT_LANGUAGE',
      message: 'Future-event wording requires evidence that the event has not ended.',
      pattern: /\b(?:get ready|prepar(?:e|ed|ing) for|ahead of|in advance of|upcoming|on the horizon)\b/gi,
      qualifies: (fact: TemporalFactAudit) => fact.disposition === 'current_trigger'
        && (fact.lifecycle === 'upcoming' || fact.lifecycle === 'ongoing'),
      framing: ['anticipatory', 'active'],
    },
  ];
  for (const rule of highRisk) {
    const ids = new Set(audit.facts.filter(rule.qualifies).map((fact) => fact.factId));
    for (const match of combined.matchAll(rule.pattern)) {
      const start = match.index ?? -1;
      const end = start + match[0].length;
      const bound = ledgerBindings.some(({ entry, start: ledgerStart, end: ledgerEnd }) => {
        return entry.factIds.some((id) => ids.has(id))
          && rule.framing.includes(entry.temporalFraming)
          && (grounding?.usedFactIds.some((id) => ids.has(id)) ?? false)
          && ledgerStart >= 0 && start >= ledgerStart && end <= ledgerEnd;
      });
      if (!bound) findings.push({ code: rule.code, message: rule.message, matchedText: match[0] });
    }
  }

  const sentences = completeDraftSentences(body);
  const sentenceCounts = new Map<string, number>();
  const ledgerCounts = new Map<string, number>();
  for (const sentence of sentences) sentenceCounts.set(sentence, (sentenceCounts.get(sentence) ?? 0) + 1);
  for (const entry of grounding?.claimLedger ?? []) {
    ledgerCounts.set(entry.exactText, (ledgerCounts.get(entry.exactText) ?? 0) + 1);
  }
  for (const [sentence, count] of sentenceCounts) {
    if ((ledgerCounts.get(sentence) ?? 0) < count) {
      findings.push({
        code: 'TEMPORAL_SENTENCE_GROUNDING_MISSING',
        message: 'Every complete draft sentence must have an exact claim ledger entry.',
        matchedText: sentence,
      });
    }
  }
  const byId = new Map(audit.facts.map((fact) => [fact.factId, fact]));
  const prospectIds = new Set((grounding?.claimLedger ?? [])
    .filter((entry) => entry.claimType === 'prospect_fact')
    .flatMap((entry) => entry.factIds));
  for (const id of grounding?.usedFactIds ?? []) {
    if (!byId.has(id) || !prospectIds.has(id)) {
      findings.push({
        code: 'TEMPORAL_GROUNDING_INCOMPLETE',
        message: `Used fact ${id} must have a matching prospect claim ledger entry.`,
        matchedText: id,
      });
    }
  }
  for (const entry of grounding?.claimLedger ?? []) {
    if (!entry.exactText || !sentences.includes(entry.exactText)) {
      findings.push({
        code: 'TEMPORAL_LEDGER_TEXT_MISSING',
        message: 'Claim ledger text must be one complete verbatim body sentence.',
        matchedText: entry.exactText,
      });
      continue;
    }
    const lower = entry.exactText.toLowerCase();
    const ask = entry.exactText.endsWith('?') || ASK_LANGUAGE.test(entry.exactText);
    const lifecycle = ACTIVE_LANGUAGE.test(entry.exactText)
      || ANTICIPATORY_LANGUAGE.test(entry.exactText)
      || RETROSPECTIVE_LANGUAGE.test(entry.exactText);
    const named = (grounding?.prospectTerms ?? []).some((term) =>
      term.trim().length >= 3 && lower.includes(term.trim().toLowerCase()));
    const direct = DIRECT_PROSPECT_LANGUAGE.test(entry.exactText)
      && !(SENDER_LANGUAGE.test(entry.exactText) && !lifecycle && !named);
    const prospect = !ask && (
      named || direct
      || (lifecycle && TEMPORAL_SUBJECT_LANGUAGE.test(entry.exactText)
        && !SENDER_LANGUAGE.test(entry.exactText))
    );
    if (prospect && entry.claimType !== 'prospect_fact') {
      findings.push({
        code: 'TEMPORAL_PROSPECT_SENTENCE_MISCLASSIFIED',
        message: 'Sentences naming the prospect must be grounded as prospect facts.',
        matchedText: entry.exactText,
      });
    }
    if (entry.claimType !== 'prospect_fact') continue;
    if (!entry.factIds.length || entry.temporalFraming === 'none') {
      findings.push({
        code: 'TEMPORAL_FRAMING_MISSING',
        message: 'Every prospect claim requires fact IDs and an explicit temporal framing.',
        matchedText: entry.exactText,
      });
      continue;
    }
    if (!framingMatches(entry.temporalFraming, entry.exactText)) {
      findings.push({
        code: 'TEMPORAL_SENTENCE_FRAMING_MISMATCH',
        message: `Sentence language conflicts with declared ${entry.temporalFraming} framing.`,
        matchedText: entry.exactText,
      });
    }
    for (const id of entry.factIds) {
      const fact = byId.get(id);
      if (!grounding?.usedFactIds.includes(id) || !fact
        || !fact.permittedFraming.includes(entry.temporalFraming)) {
        findings.push({
          code: 'TEMPORAL_FRAMING_NOT_PERMITTED',
          message: `Framing ${entry.temporalFraming} is not permitted for fact ${id}.`,
          matchedText: entry.exactText,
        });
      }
    }
  }
  if (audit.status === 'blocked') {
    findings.push({
      code: 'RESEARCH_TIMELINESS_BLOCKED',
      message: 'Research is expired or has no temporally safe selected evidence.',
      matchedText: '',
    });
  }
  return findings;
}
