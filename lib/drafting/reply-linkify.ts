import {
  REPLY_CALENDLY_URL,
  REPLY_WEBSITE_HREF,
  REPLY_WEBSITE_VISIBLE,
} from '@/lib/drafting/reply-constants';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Convert reply plain text to HTML paragraphs with required hyperlinks:
 * - bare heliosgroup.ai → linked to https://heliosgroup.ai
 * - Calendly URL → clickable href
 */
export function replyPlainTextBodyToHtml(bodyText: string): string {
  const normalized = bodyText.replace(/\r\n/g, '\n').trim();
  if (!normalized) return '';

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => {
      const linked = linkifyReplyPlainFragment(paragraph);
      const withBreaks = linked.replace(/\n/g, '<br>\n');
      return `<p style="margin:0 0 1em 0;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#111111;">${withBreaks}</p>`;
    })
    .join('\n');
}

/** Escape + linkify a single plain-text fragment (no paragraph wrapping). */
export function linkifyReplyPlainFragment(fragment: string): string {
  const escaped = escapeHtml(fragment);
  const calendlyHref = escapeHtml(REPLY_CALENDLY_URL);
  const withCalendly = escaped.replace(
    new RegExp(escapeRegExp(REPLY_CALENDLY_URL), 'g'),
    `<a href="${calendlyHref}" style="color:#027FF1;text-decoration:underline;">${calendlyHref}</a>`,
  );
  const websiteHref = escapeHtml(REPLY_WEBSITE_HREF);
  const websiteVisible = escapeHtml(REPLY_WEBSITE_VISIBLE);
  // Bare domain only (escaped text never sits inside an href yet).
  return withCalendly.replace(
    new RegExp(`\\b${escapeRegExp(REPLY_WEBSITE_VISIBLE)}\\b`, 'gi'),
    `<a href="${websiteHref}" style="color:#027FF1;text-decoration:underline;">${websiteVisible}</a>`,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
