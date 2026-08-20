import { hasLowercaseGreetingBodyOpen, hasSameLineGreeting } from '@/lib/drafting/normalize';
import type { LintFinding, LintResult } from '@/lib/drafting/types';

type LintRule = {
  code: string;
  message: string;
  severity: 'hard' | 'warning';
  pattern: RegExp;
};

const BANNED_PHRASES: LintRule[] = [
  { code: 'BANNED_PHRASE', message: 'Banned greeting filler', severity: 'hard', pattern: /\bhope this finds you well\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned greeting filler', severity: 'hard', pattern: /\bhope you['’]re having\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bquick question\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bleading (provider|platform)\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bi['’]ve noticed many companies\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bcompare notes\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bhappy to share our perspective\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bwalk you through\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bis this something you handle\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bwho should i speak with\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\blet me know what time works best\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bno ask here\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bjust wanted to introduce myself\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bexchange notes\b/i },
  { code: 'BANNED_PHRASE', message: 'Banned vendor phrase', severity: 'hard', pattern: /\bif you could let me know either way\b/i },
  // Peer-benchmarking / value-commitment bait: prices cross-client insight or
  // "what we're seeing" as the reward for a call/reply. Org-level Embark
  // experience is not the individual writer's knowledge to offer.
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\btrade\s+(a\s+few\s+)?(perspective|perspectives|notes|thoughts)\b/i },
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\b(talk|chat|speak)\s+(through|about)\s+(what|how)\s+other\b/i },
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\b(hear|compare)\s+how\s+other\b/i },
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\bwhat we['’]re seeing\b/i },
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\b(what|how)\s+other\s+[a-z][\w\s,'-]{0,80}?\b(teams?|companies|clients|firms|organi[sz]ations|peers|leaders|operators|manufacturers|developments)\b/i },
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\bhow\s+(other\s+)?finance\s+(teams?|organi[sz]ations|leaders|functions?)\b.{0,100}\b(are|have|typically|handling|managing|structured|hold up|approaching|prioritizing)\b/i },
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\bhow\s+finance\s+(is\s+)?structured\b/i },
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\b(compare|comparing)\s+where\b.{0,120}\b(similar|stands against|embark has helped)\b/i },
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\bembark has helped\s+similar\b/i },
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\bacross\s+similar\s+(manufacturers|operators|companies|teams|firms)\b/i },
  { code: 'PEER_BENCHMARK_CLAIM', message: 'Unbased cross-client/peer benchmarking claim used as call bait', severity: 'hard', pattern: /\buseful to (talk through|trade|hear how|compare where)\b/i },
  { code: 'BANNED_TRADE_CTA', message: 'Banned "trade" in ask/close/CTA', severity: 'hard', pattern: /\bto\s+trade\b/i },
  { code: 'BANNED_TRADE_CTA', message: 'Banned "trade" in ask/close/CTA', severity: 'hard', pattern: /\b(want|like|happy|open|useful)\s+to\s+trade\b/i },
  { code: 'EMBARK_GROUP_LABEL', message: 'Banned Embark self-reference as "group"', severity: 'hard', pattern: /\b(our|embark(?:['’]s)?)\s+group\b/i },
  { code: 'ANNOUNCING_BREVITY', message: 'Announcing brevity', severity: 'hard', pattern: /\bi['’]ll keep this brief\b/i },
  { code: 'ANNOUNCING_BREVITY', message: 'Announcing brevity', severity: 'hard', pattern: /\bquick note\b/i },
  { code: 'UNSUBSCRIBE', message: 'Unsubscribe language', severity: 'hard', pattern: /\bunsubscribe\b/i },
  { code: 'UNSUBSCRIBE', message: 'Unsubscribe language', severity: 'hard', pattern: /\bopt[\s-]?out\b/i },
  { code: 'TESTIMONIAL_COUNT', message: 'Testimonial count language', severity: 'hard', pattern: /\b\d+\+?\s*(clients|customers|companies)\b/i },
  // Performative humility / self-sabotage — never ship these (Issues A/B).
  { code: 'HUMILITY_THEATER', message: 'Verbalized ignorance / guessing disclaimer', severity: 'hard', pattern: /\bi (do not|don['’]t) know\b/i },
  { code: 'HUMILITY_THEATER', message: 'Verbalized ignorance / guessing disclaimer', severity: 'hard', pattern: /\b(will not|won['’]t) guess\b/i },
  { code: 'HUMILITY_THEATER', message: 'Verbalized ignorance / guessing disclaimer', severity: 'hard', pattern: /\bso i (will not|won['’]t) guess\b/i },
  { code: 'TRACK_RECORD_DISCLAIMER', message: 'Self-undermining track-record / expertise disclaimer', severity: 'hard', pattern: /\b(no|don['’]t have|do not have|without) .{0,60}track record\b/i },
  { code: 'TRACK_RECORD_DISCLAIMER', message: 'Self-undermining track-record / expertise disclaimer', severity: 'hard', pattern: /\b(no|don['’]t have|do not have) .{0,60}(expertise|hospitality experience)\b/i },
  { code: 'TRACK_RECORD_DISCLAIMER', message: 'Self-undermining track-record / expertise disclaimer', severity: 'hard', pattern: /\bsay that plainly rather than imply\b/i },
];

const STRUCTURAL_RULES: LintRule[] = [
  { code: 'EM_DASH', message: 'Unicode em dash', severity: 'hard', pattern: /\u2014/g },
  { code: 'EM_DASH', message: 'Em dash HTML entity', severity: 'hard', pattern: /&mdash;|&#8212;/gi },
  { code: 'HTML_TAG', message: 'HTML tag', severity: 'hard', pattern: /<\/?[a-z][^>]*>/i },
  { code: 'MARKDOWN_BULLET', message: 'Markdown bullet', severity: 'hard', pattern: /^\s*[-*+]\s+/m },
  { code: 'MARKDOWN_NUMBERED', message: 'Numbered value proposition layout', severity: 'hard', pattern: /^\s*\d+\.\s+/m },
  { code: 'MARKDOWN_BOLD', message: 'Markdown bold marker', severity: 'hard', pattern: /\*\*[^*]+\*\*/ },
  { code: 'MARKDOWN_HEADING', message: 'Markdown heading', severity: 'hard', pattern: /^#{1,6}\s+/m },
  { code: 'CALENDAR_LINK', message: 'Calendar link', severity: 'hard', pattern: /\b(calendar\.app\.google|calendly\.com|hubspot\.com\/meetings)\b/i },
  { code: 'PROOF_LINK', message: 'Proof/testimonial link', severity: 'hard', pattern: /\b(case study|customer story|testimonial)\b.*https?:\/\//i },
  { code: 'CONTROL_CHAR', message: 'Control character or null byte', severity: 'hard', pattern: /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/ },
  { code: 'MULTIPLE_SUBJECT', message: 'Multiple subject lines', severity: 'hard', pattern: /\bsubject\s*:/i },
  { code: 'VARIANT_LABEL', message: 'Variant label', severity: 'hard', pattern: /\b(option|variant)\s*[ab123]\b/i },
  { code: 'PROHIBITED_PEOPLE', message: 'Prohibited Embark team reference', severity: 'hard', pattern: /\bour people at embark\b/i },
  { code: 'MEETING_ASK', message: 'Meeting ask language', severity: 'hard', pattern: /\b(set up a (call|meeting|time)|schedule (a )?(call|meeting|time)|find time to connect)\b/i },
];

const WARNING_RULES: LintRule[] = [
  { code: 'GREETING_FILLER', message: 'Possible greeting-card filler', severity: 'warning', pattern: /\bhope all is well\b/i },
  { code: 'RULE_OF_THREE', message: 'Rule-of-three cadence', severity: 'warning', pattern: /\b(one|first)[^.!?]{0,40}\b(two|second)[^.!?]{0,40}\b(three|third)\b/i },
  { code: 'INTENSIFIER', message: 'Excessive intensifier', severity: 'warning', pattern: /\b(very|really|extremely|incredibly)\b/gi },
  { code: 'OVERLONG_SUBJECT', message: 'Overlong subject', severity: 'warning', pattern: /.{61,}/ },
];

const MAX_BODY_WORDS = 120;
const MAX_SENTENCES_PER_PARAGRAPH = 3;

function countWords(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

function countSentences(text: string): number {
  return [...text.matchAll(/[^.!?]+[.!?]+|[^.!?]+$/g)]
    .map((match) => match[0].trim())
    .filter(Boolean).length;
}

function collectMatches(
  text: string,
  field: LintFinding['field'],
  rule: LintRule,
): LintFinding[] {
  const findings: LintFinding[] = [];
  const pattern = rule.pattern.global
    ? rule.pattern
    : new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);

  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    const matchedText = match[0];
    findings.push({
      code: rule.code,
      message: rule.message,
      field,
      span: {
        start,
        end: start + matchedText.length,
        text: matchedText,
      },
    });
  }
  return findings;
}

function lintField(
  text: string,
  field: LintFinding['field'],
  rules: readonly LintRule[],
): LintFinding[] {
  if (!text) return [];
  return rules.flatMap((rule) => collectMatches(text, field, rule));
}

function countMeetingAsks(body: string): number {
  const patterns = [
    /\b(set up a (call|meeting|time))\b/gi,
    /\b(schedule (a )?(call|meeting|time))\b/gi,
    /\b(find time to connect)\b/gi,
    /\b(let me know if you(?:'|’)d like to (talk|chat|connect))\b/gi,
  ];
  let count = 0;
  for (const pattern of patterns) {
    count += [...body.matchAll(pattern)].length;
  }
  return count;
}

function subjectBenefitHeuristic(subject: string): LintFinding[] {
  const words = subject.trim().split(/\s+/);
  if (words.length < 3) return [];
  const titleCaseWords = words.filter((word) => /^[A-Z][a-z]+(?:['’][a-z]+)?$/.test(word));
  if (titleCaseWords.length / words.length >= 0.75 && /\b(for|with|your|our|boost|drive|unlock|transform)\b/i.test(subject)) {
    return [{
      code: 'SUBJECT_BENEFIT_LANGUAGE',
      message: 'Subject reads like campaign benefit language',
      field: 'subject',
      span: { start: 0, end: subject.length, text: subject },
    }];
  }
  return [];
}

const STACK_MARKERS = /\b(alongside|on top of|as well as|rather than|in addition to|while also)\b/gi;

/**
 * Catch clause-stack sentences that force a second read (Issue D).
 * Requires stack-marker evidence — comma density alone is not enough
 * (a serial list of three examples is normal outreach prose, not overload).
 */
export function findOverloadedSentences(bodyText: string): LintFinding[] {
  if (!bodyText.trim()) return [];
  const findings: LintFinding[] = [];
  const sentencePattern = /[^.!?]+[.!?]+|[^.!?]+$/g;
  let match: RegExpExecArray | null;
  while ((match = sentencePattern.exec(bodyText)) != null) {
    const sentence = match[0].trim();
    if (sentence.length < 120) continue;
    const commas = (sentence.match(/,/g) ?? []).length;
    const stackHits = [...sentence.matchAll(STACK_MARKERS)].length;
    const overloaded =
      (commas >= 2 && stackHits >= 1 && sentence.length >= 130)
      || (stackHits >= 2 && sentence.length >= 120);
    if (!overloaded) continue;
    findings.push({
      code: 'OVERLOADED_SENTENCE',
      message: 'Sentence stacks too many clauses/appositions — split it',
      field: 'body',
      span: {
        start: match.index,
        end: match.index + match[0].length,
        text: sentence.slice(0, 180),
      },
    });
  }
  return findings;
}

export function lintDraft(subject: string, bodyText: string): LintResult {
  const hard: LintFinding[] = [];
  const warnings: LintFinding[] = [];

  if (/\r|\n/.test(subject)) {
    hard.push({
      code: 'SUBJECT_NEWLINE',
      message: 'Subject contains line break',
      field: 'subject',
      span: { start: 0, end: subject.length, text: subject },
    });
  }

  const hardRules = [...BANNED_PHRASES, ...STRUCTURAL_RULES];
  for (const finding of lintField(subject, 'subject', hardRules)) {
    hard.push(finding);
  }
  for (const finding of lintField(bodyText, 'body', hardRules)) {
    hard.push(finding);
  }
  for (const finding of lintField(subject, 'subject', WARNING_RULES)) {
    warnings.push(finding);
  }
  for (const finding of lintField(bodyText, 'body', WARNING_RULES)) {
    warnings.push(finding);
  }

  hard.push(...subjectBenefitHeuristic(subject));
  hard.push(...findOverloadedSentences(bodyText));
  if (hasSameLineGreeting(bodyText)) {
    const firstLine = bodyText.split(/\n/, 1)[0] ?? bodyText;
    hard.push({
      code: 'GREETING_LINE_BREAK',
      message: 'Opening "[First name]," must be on its own line, then a blank line',
      field: 'body',
      span: { start: 0, end: Math.min(firstLine.length, 80), text: firstLine.slice(0, 80) },
    });
  } else if (hasLowercaseGreetingBodyOpen(bodyText)) {
    const open = bodyText.match(/\n\n(\S)/);
    const idx = open ? bodyText.indexOf(open[1], bodyText.indexOf('\n\n')) : 0;
    hard.push({
      code: 'GREETING_BODY_CAPITALIZATION',
      message: 'First word after the greeting blank line must be capitalized',
      field: 'body',
      span: { start: Math.max(0, idx), end: Math.min(bodyText.length, idx + 24), text: bodyText.slice(idx, idx + 24) },
    });
  }

  const wordCount = countWords(bodyText);
  if (wordCount > MAX_BODY_WORDS) {
    warnings.push({
      code: 'OVERLONG_BODY',
      message: `Body exceeds ${MAX_BODY_WORDS} words (${wordCount})`,
      field: 'body',
      span: { start: 0, end: bodyText.length, text: bodyText.slice(0, 180) },
    });
  }

  let paragraphOffset = 0;
  for (const paragraph of bodyText.split(/\n\s*\n/)) {
    const sentenceCount = countSentences(paragraph);
    if (sentenceCount > MAX_SENTENCES_PER_PARAGRAPH) {
      warnings.push({
        code: 'OVERLONG_PARAGRAPH',
        message: `Paragraph has more than ${MAX_SENTENCES_PER_PARAGRAPH} sentences`,
        field: 'body',
        span: {
          start: paragraphOffset,
          end: paragraphOffset + paragraph.length,
          text: paragraph.slice(0, 180),
        },
      });
    }
    paragraphOffset += paragraph.length + 2;
  }

  if (countMeetingAsks(bodyText) > 1) {
    hard.push({
      code: 'MULTIPLE_MEETING_ASKS',
      message: 'More than one obvious meeting ask/CTA',
      field: 'body',
      span: { start: 0, end: bodyText.length, text: bodyText },
    });
  }

  return { hard, warnings };
}

export function hasHardLintFailures(result: LintResult): boolean {
  return result.hard.length > 0;
}

/**
 * Hard codes that still trigger one automatic repair, but must not fail the
 * item or block Approve if they remain after repair. Surface as "Retry suggested".
 */
export const RETRY_SUGGESTED_LINT_CODES = new Set(['OVERLOADED_SENTENCE']);

/**
 * Mechanical formatting / banned-phrase failures — worth one automatic Sonnet repair.
 * Judgment calls (humility theater, track-record disclaimers, peer bait) skip
 * auto-repair and block Approve. Overloaded sentences stay reviewable with
 * "Retry suggested" (fail open) — prevention is writer guidance, not a second write.
 */
export const MECHANICAL_AUTO_REPAIR_LINT_CODES = new Set([
  'BANNED_PHRASE',
  'EM_DASH',
  'HTML_TAG',
  'MARKDOWN_BULLET',
  'MARKDOWN_NUMBERED',
  'MARKDOWN_BOLD',
  'MARKDOWN_HEADING',
  'CALENDAR_LINK',
  'PROOF_LINK',
  'CONTROL_CHAR',
  'MULTIPLE_SUBJECT',
  'VARIANT_LABEL',
  'SUBJECT_NEWLINE',
  'UNSUBSCRIBE',
  'GREETING_LINE_BREAK',
  'GREETING_BODY_CAPITALIZATION',
]);

export function isRetrySuggestedLintCode(code: string): boolean {
  return RETRY_SUGGESTED_LINT_CODES.has(code);
}

export function isMechanicalAutoRepairLintCode(code: string): boolean {
  return MECHANICAL_AUTO_REPAIR_LINT_CODES.has(code);
}

/** True when any hard finding would block Approve / force failed_write. */
export function hasBlockingHardLintFailures(result: LintResult): boolean {
  return result.hard.some((finding) => !RETRY_SUGGESTED_LINT_CODES.has(finding.code));
}

/**
 * Judgment / temporal hard fails — not mechanical formatting. First write skips
 * auto-repair for these and surfaces the draft in review. After one mechanical
 * repair, leftover judgment must do the same; otherwise an em dash turns a
 * reviewable draft into failed_write.
 */
export function hasJudgmentHardLintFailures(result: LintResult): boolean {
  return result.hard.some((finding) =>
    !RETRY_SUGGESTED_LINT_CODES.has(finding.code)
    && !MECHANICAL_AUTO_REPAIR_LINT_CODES.has(finding.code));
}

/** True when mechanical lint warrants one automatic repair write. */
export function hasMechanicalAutoRepairLintFailures(result: LintResult): boolean {
  return result.hard.some((finding) => MECHANICAL_AUTO_REPAIR_LINT_CODES.has(finding.code));
}

/** Findings passed into the repair prompt — mechanical only. */
export function mechanicalAutoRepairFindings(result: LintResult): LintFinding[] {
  return result.hard.filter((finding) => MECHANICAL_AUTO_REPAIR_LINT_CODES.has(finding.code));
}

/** True when the draft still has soft/hard findings that warrant a manual rewrite. */
export function hasRetrySuggestedLint(result: LintResult): boolean {
  return result.hard.some((finding) => RETRY_SUGGESTED_LINT_CODES.has(finding.code));
}

/** Compact hard-lint guidance for the writer prompt (first write + repair). */
export function hardLintGuidanceForWriter(): string {
  const banned = [
    'hope this finds you well',
    "hope you're having",
    'quick question',
    'leading provider/platform',
    "I've noticed many companies",
    'compare notes',
    'happy to share our perspective',
    'walk you through',
    'is this something you handle',
    'who should I speak with',
    'let me know what time works best',
    'no ask here',
    'just wanted to introduce myself',
    'exchange notes',
    'if you could let me know either way',
    "I'll keep this brief",
    'quick note',
    'unsubscribe / opt-out',
    'N+ clients/customers/companies',
  ];
  const structural = [
    'No em dashes (—) or &mdash;',
    'No HTML tags or markdown bullets/bold/headings/numbered lists',
    'No Calendly/calendar links or case-study/testimonial links',
    'No "Subject:" labels, Option A/B variant labels, or "our people at Embark"',
    'No meeting-ask language (set up/schedule a call/meeting; find time to connect)',
    'No peer-benchmarking or value-commitment closes ("trade perspectives/notes", "talk through how other finance teams...", "what we\'re seeing across similar...", "compare where Embark has helped similar operators") — Embark\'s collective experience is not the individual writer\'s knowledge to offer as call bait',
    'Never use "trade" in the ask, close, or CTA',
    'Never refer to Embark as a "group"',
    'At most one obvious ask/CTA',
    'Subject must be a single line without benefit-campaign title case',
    'Never verbalize ignorance ("I don\'t know", "I won\'t guess") — omit unknowns instead',
    'Never claim Embark has no track record / no industry expertise',
    'Split overloaded sentences into separate short sentences; one idea per sentence; no stacked appositions or clause chains',
    'Open with "[First name]," on its own line, then a blank line, then the first sentence — never "Blane, your work…"; the first word after the blank line must be capitalized',
  ];
  return [
    'Hard skill lint (automatic reject if violated):',
    ...banned.map((phrase) => `- Never use: "${phrase}"`),
    ...structural.map((rule) => `- ${rule}`),
  ].join('\n');
}

/** Format named lint failures for repair prompts. */
export function formatHardLintFailuresForRepair(findings: LintFinding[]): string {
  if (findings.length === 0) return '(no hard lint findings provided)';
  return findings.map((finding) => (
    `- [${finding.code}] ${finding.field}: ${finding.message}`
    + (finding.span?.text ? ` (matched: ${JSON.stringify(finding.span.text)})` : '')
  )).join('\n');
}
