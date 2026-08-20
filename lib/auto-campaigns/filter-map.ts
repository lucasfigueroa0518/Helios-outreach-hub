import Anthropic from '@anthropic-ai/sdk';
import { cachedSystemText } from '@/lib/anthropic-cache';
import { priceAnthropicMessages } from '@/lib/anthropic-pricing';
import { MAPPING_MODEL, resolvedDraftingPromptCacheTtl } from '@/lib/models';
import type { LeadAttributes, PeopleSearchParams } from '@/lib/auto-campaigns/types';

const SENIORITY_ALIASES: Array<{ needles: string[]; value: string; titles?: string[] }> = [
  { needles: ['ceo', 'chief executive', 'c-suite', 'c suite', 'founder', 'co-founder', 'owner'], value: 'c_suite', titles: ['CEO', 'Founder', 'Co-Founder', 'Owner'] },
  { needles: ['cto', 'chief technology', 'vp engineering', 'vice president'], value: 'vp', titles: ['CTO', 'VP Engineering', 'VP'] },
  { needles: ['director', 'head of'], value: 'director', titles: ['Director', 'Head'] },
  { needles: ['partner'], value: 'partner', titles: ['Partner'] },
  { needles: ['manager'], value: 'manager' },
];

const SIZE_RANGES: Array<{ needles: string[]; range: string }> = [
  { needles: ['1-10', '1–10', 'micro', 'tiny'], range: '1,10' },
  { needles: ['11-50', '11–50', 'small'], range: '11,50' },
  { needles: ['51-200', '51–200', 'smb'], range: '51,200' },
  { needles: ['201-500', '201–500'], range: '201,500' },
  { needles: ['501-1000', '501–1,000', '501-1,000'], range: '501,1000' },
  { needles: ['1000', '1,000+', 'enterprise', 'large'], range: '1001,10000' },
  { needles: ['brokerage', 'boutique'], range: '11,50' },
];

const MAP_SYSTEM = `You map Autocampaign targeting text onto Apollo people-search filters.
Return ONLY a JSON object with optional keys:
person_titles (string[]), person_seniorities (string[] from owner,founder,c_suite,partner,vp,head,director,manager,senior,entry,intern),
person_locations (string[]), q_keywords (string), organization_num_employees_ranges (string[] like "11,50").
Never invent emails. Never call tools. Do not include organization_ids.`;

export function mapAttributesHeuristic(attrs: LeadAttributes): PeopleSearchParams {
  const seniorityText = attrs.seniority.toLowerCase();
  const sizeText = attrs.business_size.toLowerCase();
  const titles = new Set<string>();
  const seniorities = new Set<string>();
  for (const alias of SENIORITY_ALIASES) {
    if (alias.needles.some((needle) => seniorityText.includes(needle))) {
      seniorities.add(alias.value);
      for (const title of alias.titles ?? []) titles.add(title);
    }
  }
  if (titles.size === 0 && attrs.seniority.trim()) titles.add(attrs.seniority.trim());
  const ranges = SIZE_RANGES
    .filter((entry) => entry.needles.some((needle) => sizeText.includes(needle)))
    .map((entry) => entry.range);
  const keywords = [attrs.industry.trim(), attrs.business_size.trim()].filter(Boolean).join(' ').trim();
  return {
    person_titles: titles.size ? [...titles] : undefined,
    person_seniorities: seniorities.size ? [...seniorities] : undefined,
    person_locations: attrs.geography.trim() ? [attrs.geography.trim()] : undefined,
    q_keywords: keywords || undefined,
    organization_num_employees_ranges: ranges.length ? [...new Set(ranges)] : undefined,
  };
}

function parseMappedJson(text: string): PeopleSearchParams | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const asStringArray = (value: unknown): string[] | undefined => {
      if (!Array.isArray(value)) return undefined;
      const items = value.flatMap((entry) => typeof entry === 'string' && entry.trim() ? [entry.trim()] : []);
      return items.length ? items : undefined;
    };
    return {
      person_titles: asStringArray(parsed.person_titles),
      person_seniorities: asStringArray(parsed.person_seniorities),
      person_locations: asStringArray(parsed.person_locations),
      q_keywords: typeof parsed.q_keywords === 'string' && parsed.q_keywords.trim()
        ? parsed.q_keywords.trim()
        : undefined,
      organization_num_employees_ranges: asStringArray(parsed.organization_num_employees_ranges),
    };
  } catch {
    return null;
  }
}

export async function mapAttributesToSearchParams(
  attrs: LeadAttributes,
): Promise<{ params: PeopleSearchParams; usage?: ReturnType<typeof priceAnthropicMessages> }> {
  const fallback = mapAttributesHeuristic(attrs);
  if (!process.env.ANTHROPIC_API_KEY?.trim() || process.env.DRAFTING_MODE !== 'live') {
    return { params: fallback };
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const ttl = resolvedDraftingPromptCacheTtl();
  const message = await client.messages.create({
    model: MAPPING_MODEL,
    max_tokens: 600,
    system: cachedSystemText(MAP_SYSTEM, ttl),
    messages: [{
      role: 'user',
      content: JSON.stringify({
        industry: attrs.industry,
        seniority: attrs.seniority,
        geography: attrs.geography,
        business_size: attrs.business_size,
      }),
    }],
  });
  const text = message.content
    .flatMap((block) => block.type === 'text' ? [block.text] : [])
    .join('\n');
  const mapped = parseMappedJson(text);
  return {
    params: mapped ?? fallback,
    usage: priceAnthropicMessages([message], {
      modelId: MAPPING_MODEL,
      fallbackCacheTtl: ttl,
    }),
  };
}
