/** Shared pure domain types for the drafting feature. */

export const DRAFTING_ITEM_STATES = [
  'waiting_for_enrichment',
  'needs_lead_review',
  'verifying_mailbox',
  'removed',
  'budget_paused',
  'queued_research',
  'waiting_company_research',
  'researching',
  'queued_write',
  'writing',
  'repairing',
  'ready_for_review',
  'approved',
  'queued_rewrite',
  'rewriting',
  'failed_research',
  'failed_write',
  'failed_rewrite',
  'cancelled',
] as const;

export type DraftingItemState = (typeof DRAFTING_ITEM_STATES)[number];

export const DRAFTING_JOB_KINDS = [
  'verify_mailbox',
  'research',
  'write',
  'repair',
  'rewrite',
] as const;

export type DraftingJobKind = (typeof DRAFTING_JOB_KINDS)[number];

export const DRAFTING_JOB_STATUSES = [
  'pending',
  'in_flight',
  'done',
  'failed',
  'superseded',
  'cancelled',
] as const;

export type DraftingJobStatus = (typeof DRAFTING_JOB_STATUSES)[number];

export const MAILBOX_VERIFICATION_STATUSES = [
  'valid',
  'invalid',
  'unknown',
  'pending',
  'risky',
  'accept_all',
  'missing',
  'malformed',
  'rate_limited',
] as const;

export type MailboxVerificationStatus = (typeof MAILBOX_VERIFICATION_STATUSES)[number];

export const REVIEW_STATUSES = ['unreviewed', 'approved'] as const;

export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const SENDER_SIGNATURE_MODES = ['name', 'name_and_role'] as const;

export type SenderSignatureMode = (typeof SENDER_SIGNATURE_MODES)[number];

export const RESOLUTION_LEVELS = [
  'person',
  'company',
  'role_segment',
  'moment',
  'structure',
  'true_zero',
] as const;

export type ResolutionLevel = (typeof RESOLUTION_LEVELS)[number];

export type WriterResolutionLevel = Exclude<ResolutionLevel, 'true_zero'>;

export const CONNECTING_CONTEXT_MODES = [
  'cold',
  'previously_connected',
  'warm_introduction',
  'unknown',
] as const;

export type ConnectingContextMode = (typeof CONNECTING_CONTEXT_MODES)[number];

export const LEAD_IDENTITY_CLASSIFICATIONS = [
  'verified',
  'usable_at_lower_resolution',
  'ambiguous',
  'conflicted',
  'not_found',
] as const;

export type LeadIdentityClassification = (typeof LEAD_IDENTITY_CLASSIFICATIONS)[number];

export const SOURCE_FAMILIES = [
  'first_party_company',
  'first_party_personal',
  'regulator_filing',
  'professional_profile',
  'professional_association',
  'company_press',
  'reputable_news',
  'portfolio_investor',
  'data_broker',
  'social_post',
  'other',
] as const;

export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

export const TRUST_TIERS = ['high', 'medium', 'low'] as const;

export type TrustTier = (typeof TRUST_TIERS)[number];

export const FACT_CONFIDENCE = ['supported', 'tentative', 'conflicted'] as const;

export type FactConfidence = (typeof FACT_CONFIDENCE)[number];

export const FACT_FRESHNESS = [
  'current',
  'recent',
  'undated',
  'stale',
  'conflicted',
] as const;

export type FactFreshness = (typeof FACT_FRESHNESS)[number];

export const FACT_WEIGHT = ['anchor', 'seasoning', 'discard'] as const;

export type FactWeight = (typeof FACT_WEIGHT)[number];

export const CONTACT_NORM_FORMS = [
  'call',
  'meal',
  'reply',
  'introduction_only',
  'unknown',
] as const;

export type ContactNormForm = (typeof CONTACT_NORM_FORMS)[number];

export const ASK_FORMS = ['call', 'meal', 'reply'] as const;

export type AskForm = (typeof ASK_FORMS)[number];

export const EMBARK_CAPABILITY_CATEGORIES = [
  'strategic_finance_advisory',
  'operations_transformation',
  'technology_innovation',
  'internal_controls_risk',
] as const;

export type EmbarkCapabilityCategory = (typeof EMBARK_CAPABILITY_CATEGORIES)[number];

/** Closed v1 capability IDs from the planning spec. */
export const CANONICAL_CAPABILITY_IDS = [
  'financial_reporting_advisory',
  'pe_vc_portfolio_company_advisory',
  'office_of_the_cfo',
  'valuation',
  'capital_markets',
  'esg_sustainability',
  'deal_advisory',
  'interim_finance_leadership',
  'm_and_a_activity',
  'digital_transformation',
  'human_capital_transformation',
  'supply_chain_operations',
  'project_change_management',
  'outsourcing',
  'team_continuity',
  'embedded_project_execution_support',
  'data_analytics_automation',
  'generative_ai',
  'technology_enablement',
  'internal_controls_risk_management',
  'prepare_for_audits_and_ipos',
  'optimize_financial_operations',
  'modernize_tech_and_data',
  'scale_with_confidence',
] as const;

export type CanonicalCapabilityId = (typeof CANONICAL_CAPABILITY_IDS)[number];

export type EmbarkCapability = {
  id: CanonicalCapabilityId;
  category: EmbarkCapabilityCategory;
  label: string;
  exactSourceText: string;
  sourcePage: 1 | 2;
  allowedSummary: string;
};

export type DeliverySnapshot = {
  effectiveEmail: string;
  effectiveEmailFingerprint: string;
  emailVerification: MailboxVerificationStatus;
  verifiedAt: string | null;
  resultSource: string | null;
  providerRequestId: string | null;
};

export type InputSnapshotLead = {
  fullName: string | null;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  company: string | null;
  title: string | null;
  workLocation: string | null;
  linkedinUrl: string | null;
  emailStatus: string | null;
  emailDecision: string | null;
};

export type InputSnapshotRelationship = {
  pastWork: string | null;
  priorRelationshipActivity: string | null;
  lastContacted: string | null;
  lastContactedBy: string | null;
  relationshipTier: string | null;
  reusedFromPriorLead: boolean;
  capturedAt: string | null;
};

export type InputSnapshotConnectingContext = {
  mode: ConnectingContextMode;
  introducerName: string | null;
  suppliedContext: string | null;
  linkedinConnectionDegree: string | null;
  rawCrmIndicator: string | null;
};

export type InputSnapshotProvenance = {
  sourceRunId: string | null;
  profileEnrichment: Record<string, unknown>;
  emailProvenance: Record<string, unknown>;
};

export type InputSnapshotSender = {
  profileId: string;
  profileRevision: number;
  displayName: string;
  workEmail: string;
  title: string;
  companyName?: string | null;
  headshotStoragePath?: string | null;
  signatureMode: SenderSignatureMode;
  voiceNotes: string | null;
  professionalContext: Record<string, unknown>;
};

export type InputSnapshotAssets = {
  skillVersion: string;
  skillSha256: string;
  subjectLineVersion: string;
  subjectLineSha256: string;
  positioningVersion: string;
  positioningSha256: string;
  capabilityCatalogVersion: string;
  capabilityCatalogSha256: string;
};

export type InputSnapshot = {
  schemaVersion: 1;
  lead: InputSnapshotLead;
  relationship: InputSnapshotRelationship;
  connectingContext: InputSnapshotConnectingContext;
  /**
   * Caller-supplied per-lead columns from the upload / replaced sheet (LinkedIn
   * relationship status and any added columns), keyed by display header. Part of the
   * writer's input and the input fingerprint so drafts regenerate when it changes.
   */
  customContext: Record<string, string>;
  provenance: InputSnapshotProvenance;
  sender: InputSnapshotSender;
  assets: InputSnapshotAssets;
};

export type InputOverridesConnectingContext = {
  introducerName?: string | null;
  suppliedContext?: string | null;
  linkedinConnectionDegree?: string | null;
  rawCrmIndicatorMeaning?: string | null;
};

export type InputOverrides = {
  email?: string | null;
  fullName?: string | null;
  company?: string | null;
  title?: string | null;
  workLocation?: string | null;
  connectingContext?: InputOverridesConnectingContext;
};

export const REQUIRED_DRAFTING_FIELD_KEYS = [
  'email',
  'fullName',
  'firstName',
  'company',
  'title',
] as const;

export type RequiredDraftingFieldKey = (typeof REQUIRED_DRAFTING_FIELD_KEYS)[number];

export type EffectiveLeadFields = {
  email: string | null;
  fullName: string | null;
  firstName: string | null;
  company: string | null;
  title: string | null;
  workLocation: string | null;
};

export type FreshnessFinding = {
  status: FactFreshness | 'undated-current-page';
  sourceIds: string[];
  summary: string | null;
};

export type EvidenceBackedStatement = {
  statement: string;
  sourceIds: string[];
  confidence: Exclude<FactConfidence, 'conflicted'>;
};

export type ResearchSource = {
  id: string;
  url: string;
  title: string;
  family: SourceFamily;
  trustTier: TrustTier;
  publishedOrUpdated: string | null;
  accessedAt: string;
  quote: string;
  bindsPerson: boolean;
};

export type ResearchFact = {
  id: string;
  normalizedClaim: string;
  sourceIds: string[];
  quote: string;
  family: SourceFamily;
  confidence: FactConfidence;
  freshness: FactFreshness;
  weight: FactWeight;
  significanceReason: string;
  temporal?: {
    kind: 'event' | 'current_state' | 'evergreen';
    eventClass:
      | 'appointment'
      | 'short_lived'
      | 'project'
      | 'transaction'
      | 'deadline'
      | 'conference'
      | 'announcement'
      | 'structural'
      | 'generic';
    eventStart: string | null;
    eventEnd: string | null;
    relevanceEnd: string | null;
    durationBasis: 'explicit_source' | 'derived_from_event' | 'policy_default' | 'unknown';
    durationSourceIds: string[];
    durationEvidence: string | null;
    discourse: 'current_trigger' | 'ongoing' | 'historical_context' | 'timeless';
  } | null;
};

export type DraftingResearchPacket = {
  schemaVersion: '2';
  asOf: string;
  leadIdentity: {
    classification: LeadIdentityClassification;
    suppliedSummary: string;
    currentSummary: string | null;
    conflictSummary: string | null;
    supportingSourceIds: string[];
  };
  freshness: {
    employer: FreshnessFinding;
    title: FreshnessFinding;
    location: FreshnessFinding;
  };
  prospectWorld: {
    roleReality: string;
    pressures: EvidenceBackedStatement[];
    contactNorm: {
      form: ContactNormForm;
      statement: string;
      sourceIds: string[];
      confidence: Exclude<FactConfidence, 'conflicted'>;
    };
    registerNotes: string[];
    commonVendorPatterns: string[];
  };
  personFacts: ResearchFact[];
  companyFacts: ResearchFact[];
  roleSegmentFacts: ResearchFact[];
  structuralRelation: {
    relation: 'complementary' | 'adjacent' | 'potential_tension' | 'unclear';
    recipientConstraint: string | null;
    embarkCapabilityId: string | null;
    supportedReason: string | null;
    tensionToName: string | null;
    sourceIds: string[];
  };
  statusGeometry: {
    classification:
      | 'peer'
      | 'sender_junior'
      | 'sender_senior'
      | 'unknown_to_established'
      | 'adjacent_principals'
      | 'uncertain';
    safePosture: string;
    basis: string;
  };
  resolution: {
    level: ResolutionLevel;
    selectedFactIds: string[];
    reasonForWriting: string | null;
    whyNow: string | null;
    prohibitedAssumptions: string[];
  };
  resolutionUpgrade: {
    obtainableFact: string | null;
    whyItWouldRaiseResolution: string | null;
    howToObtainWithoutGuessing: string | null;
  };
  companyContextProvenance: {
    origin: 'fresh' | 'reused_within_workspace';
    sourceDraftingItemId: string | null;
    resolvedDomain: string | null;
    validUntil: string | null;
  };
  sources: ResearchSource[];
};

/**
 * Small, writer-relevant company context shared by leads in one workspace.
 * Person facts and identity never cross lead boundaries.
 */
export type ReusableCompanyResearchContext = {
  sourceDraftingItemId: string;
  company: string;
  validUntil: string;
  prospectWorld: {
    pressures: EvidenceBackedStatement[];
  };
  companyFacts: ResearchFact[];
  roleSegmentFacts: ResearchFact[];
  sources: ResearchSource[];
};

export type DraftClaimLedgerEntry = {
  exactText: string;
  factIds: string[];
  claimType: 'prospect_fact' | 'sender_fact' | 'relationship_fact';
  temporalFraming:
    | 'none'
    | 'anticipatory'
    | 'active'
    | 'retrospective'
    | 'current_context'
    | 'historical_context'
    | 'timeless';
};

export type DraftGenerationMode = 'live' | 'stub' | 'legacy';

export type DraftOutputChecks = {
  reasonClearInFirstThreeSentences: boolean;
  oneIdea: boolean;
  oneReason: boolean;
  oneAsk: boolean;
  noInventedSpecifics: boolean;
  noVendorPattern: boolean;
  noEmDash: boolean;
  noMarketingFormatting: boolean;
  senderFactsFromProvidedSourcesOnly: boolean;
  /**
   * Writer self-attestation on clause stacking. Recorded, not enforced: nothing
   * fails or blocks Approve on a false value, matching every other check here.
   */
  noStackedClauses: boolean;
  everySentenceParsesOnFirstRead: boolean;
};

export type DraftOutput = {
  schemaVersion: '1';
  subject: string;
  bodyText: string;
  resolutionUsed: WriterResolutionLevel;
  usedFactIds: string[];
  claimLedger: DraftClaimLedgerEntry[];
  askForm: AskForm;
  checks: DraftOutputChecks;
};

export type LintSpan = {
  start: number;
  end: number;
  text: string;
};

export type LintFinding = {
  code: string;
  message: string;
  field: 'subject' | 'body' | 'combined';
  span: LintSpan;
};

export type LintResult = {
  hard: LintFinding[];
  warnings: LintFinding[];
};

export type DraftingItemCounterInput = {
  state: DraftingItemState;
  deliverySnapshot: DeliverySnapshot | null;
  removedAt?: string | null;
};

export type DraftingCounterSnapshot = {
  waitingForEnrichment: number;
  leadsAttention: number;
  verifying: number;
  removed: number;
  budgetPaused: number;
  running: number;
  generated: number;
  approved: number;
  failed: number;
  mailboxValidTotal: number;
  drafted: number;
};
