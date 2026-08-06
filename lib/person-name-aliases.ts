const NICKNAME_GROUPS = [
  ['alexander', 'alex', 'xander'],
  ['alexandra', 'alex', 'lexi'],
  ['andrew', 'andy', 'drew'],
  ['anthony', 'tony'],
  ['benjamin', 'ben', 'benny'],
  ['charles', 'charlie', 'chuck'],
  ['christopher', 'chris'],
  ['daniel', 'dan', 'danny'],
  ['david', 'dave', 'davy'],
  ['deborah', 'debbie', 'deb'],
  ['edward', 'ed', 'eddie', 'ted'],
  ['elizabeth', 'liz', 'lizzy', 'beth', 'betsy'],
  ['francis', 'frank'],
  ['frederick', 'fred', 'freddie'],
  ['gregory', 'greg'],
  ['harold', 'harry'],
  ['jacqueline', 'jackie'],
  ['james', 'jim', 'jimmy'],
  ['jennifer', 'jen', 'jenny'],
  ['jessica', 'jess'],
  ['joseph', 'joe', 'joey'],
  ['joshua', 'josh'],
  ['katherine', 'kathryn', 'kathy', 'kate', 'katie'],
  ['kenneth', 'ken', 'kenny'],
  ['lawrence', 'larry'],
  ['margaret', 'maggie', 'meg', 'peggy'],
  ['matthew', 'matt'],
  ['michael', 'mike'],
  ['nicholas', 'nick', 'nicky'],
  ['patricia', 'pat', 'tricia'],
  ['patrick', 'pat'],
  ['rebecca', 'becky', 'becca'],
  ['richard', 'rich', 'rick', 'dick'],
  ['robert', 'rob', 'bob', 'bobby'],
  ['ronald', 'ron', 'ronnie'],
  ['samuel', 'sam', 'sammy'],
  ['stephen', 'steven', 'steve'],
  ['susan', 'sue', 'susie'],
  ['theodore', 'theo', 'ted', 'teddy'],
  ['thomas', 'tom', 'tommy'],
  ['timothy', 'tim'],
  ['victoria', 'vicky', 'tori'],
  ['william', 'will', 'bill', 'billy', 'liam'],
] as const;

const suffixes = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'cpa', 'mba', 'phd', 'md', 'esq']);
const nicknameIndex = new Map<string, Set<string>>();

for (const group of NICKNAME_GROUPS) {
  for (const name of group) {
    const aliases = nicknameIndex.get(name) ?? new Set<string>();
    for (const alias of group) aliases.add(alias);
    nicknameIndex.set(name, aliases);
  }
}

export function normalizePersonToken(value: string) {
  return value.normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function personNameParts(value: string) {
  const parenthetical = [...value.matchAll(/\(([^)]+)\)/g)]
    .flatMap((match) => normalizePersonToken(match[1]).split(' '))
    .filter(Boolean);
  const tokens = normalizePersonToken(value.replace(/\([^)]*\)/g, ' '))
    .split(' ')
    .filter((token) => token && !suffixes.has(token));
  return {
    tokens,
    first: tokens[0] ?? '',
    last: tokens.at(-1) ?? '',
    parenthetical,
  };
}

export function firstNameAliases(firstName: string, preferred: string[] = []) {
  const first = normalizePersonToken(firstName).split(' ')[0] ?? '';
  const aliases = new Set<string>([first, ...preferred.map(normalizePersonToken)]);
  for (const alias of nicknameIndex.get(first) ?? []) aliases.add(alias);
  for (const preferredName of preferred) {
    for (const alias of nicknameIndex.get(normalizePersonToken(preferredName)) ?? []) aliases.add(alias);
  }
  return [...aliases].filter(Boolean);
}

export type NameSearchVariant = {
  label: 'formal' | 'nickname' | 'initial_last' | 'compact';
  display: string;
};

export function buildNameSearchVariants(person: {
  full_name: string;
  first_name?: string | null;
  last_name?: string | null;
}): NameSearchVariant[] {
  const parsed = personNameParts(person.full_name);
  const first = normalizePersonToken(person.first_name ?? parsed.first);
  const last = normalizePersonToken(person.last_name ?? parsed.last);
  if (!last) return parsed.tokens.length ? [{ label: 'formal', display: parsed.tokens.join(' ') }] : [];

  const variants: NameSearchVariant[] = [];
  const add = (label: NameSearchVariant['label'], display: string) => {
    const normalized = display.replace(/\s+/g, ' ').trim();
    if (normalized && !variants.some((variant) => variant.display === normalized)) {
      variants.push({ label, display: normalized });
    }
  };
  add('formal', [first, last].filter(Boolean).join(' '));
  for (const alias of firstNameAliases(first, parsed.parenthetical)) {
    if (alias !== first) add('nickname', `${alias} ${last}`);
  }
  if (first) add('initial_last', `${first[0]} ${last}`);
  if (first) add('compact', `${first[0]}${last}`);
  return variants;
}
