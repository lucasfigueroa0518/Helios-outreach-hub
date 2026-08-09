import {
  REPLY_CALENDLY_URL,
  REPLY_WEBSITE_VISIBLE,
  type ReplyDisposition,
} from '@/lib/drafting/reply-constants';

export type ReplyLintFinding = {
  code: string;
  message: string;
  severity: 'hard';
};

const EM_DASH = /\u2014|\u2013|\s--\s/;

export function lintReplyBody(
  bodyText: string,
  options: {
    websiteToolUsed?: boolean;
    disposition?: ReplyDisposition;
    includeCalendly?: boolean;
  } = {},
): ReplyLintFinding[] {
  const findings: ReplyLintFinding[] = [];
  const body = bodyText.replace(/\r\n/g, '\n').trim();
  const disposition = options.disposition ?? 'reply_now';
  const includeCalendly = options.includeCalendly ?? (disposition === 'reply_now');

  if (!body) {
    findings.push({ code: 'EMPTY_BODY', message: 'Reply body is empty', severity: 'hard' });
    return findings;
  }

  if (EM_DASH.test(body)) {
    findings.push({
      code: 'EM_DASH',
      message: 'Reply must not contain em dashes, en dashes, or spaced double hyphens',
      severity: 'hard',
    });
  }

  const hasCalendly = body.includes(REPLY_CALENDLY_URL);

  if (disposition === 'suppress' || disposition === 'defer') {
    if (hasCalendly || includeCalendly) {
      findings.push({
        code: 'CALENDLY_FORBIDDEN',
        message: `${disposition} replies must not include Calendly`,
        severity: 'hard',
      });
    }
  } else if (includeCalendly && !hasCalendly) {
    findings.push({
      code: 'MISSING_CALENDLY',
      message: `Reply must include ${REPLY_CALENDLY_URL}`,
      severity: 'hard',
    });
  } else if (!includeCalendly && hasCalendly) {
    findings.push({
      code: 'CALENDLY_UNEXPECTED',
      message: 'includeCalendly is false but body contains Calendly URL',
      severity: 'hard',
    });
  }

  const mentionsWebsite = /\bhelios\s*website\b|\bour website\b|\bheliosgroup\.ai\b/i.test(body);
  if ((options.websiteToolUsed || mentionsWebsite) && !body.includes(REPLY_WEBSITE_VISIBLE)) {
    findings.push({
      code: 'WEBSITE_ANCHOR',
      message: `When referring to the website, include bare text ${REPLY_WEBSITE_VISIBLE}`,
      severity: 'hard',
    });
  }

  return findings;
}

export function replyLintHardCodes(findings: ReplyLintFinding[]): Set<string> {
  return new Set(findings.map((f) => f.code));
}
