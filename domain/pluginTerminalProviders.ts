import { RegExpParser, type AST } from '@eslint-community/regexpp';

export const MAX_PLUGIN_COMPLETION_ITEMS = 100;
export const MAX_PLUGIN_DECORATION_RULES = 64;

const pluginPatternParser = new RegExpParser({ ecmaVersion: 2025 });
const MAX_PLUGIN_PATTERN_QUANTIFIERS = 32;

export interface PluginTerminalCompletionItem {
  readonly text: string;
  readonly displayText: string;
  readonly description?: string;
  readonly score: number;
  readonly providerId: string;
}

export interface PluginTerminalDecorationRule {
  readonly id: string;
  readonly label: string;
  readonly patterns: readonly string[];
  readonly color: string;
  readonly enabled: true;
  readonly providerId: string;
}

function hasUnsafeTextControl(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || (codePoint >= 0x202a && codePoint <= 0x202e)
      || (codePoint >= 0x2066 && codePoint <= 0x2069)) return true;
  }
  return false;
}

function boundedString(value: unknown, maximum: number, allowEmpty = false): string | null {
  if (typeof value !== 'string'
    || value.length > maximum
    || (!allowEmpty && value.length < 1)
    || hasUnsafeTextControl(value)) {
    return null;
  }
  return value;
}

function finiteScore(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(-1_000_000, Math.min(1_000_000, value))
    : 0;
}

function freezeArray<T extends object>(values: T[]): readonly Readonly<T>[] {
  for (const value of values) Object.freeze(value);
  return Object.freeze(values);
}

export function normalizePluginCompletionResult(
  providerId: string,
  value: unknown,
): readonly PluginTerminalCompletionItem[] {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { items?: unknown }
    : null;
  if (!Array.isArray(source?.items) || source.items.length > MAX_PLUGIN_COMPLETION_ITEMS) return Object.freeze([]);
  const items: PluginTerminalCompletionItem[] = [];
  for (const candidate of source.items) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const item = candidate as Record<string, unknown>;
    const text = boundedString(item.text, 4_096);
    if (!text) continue;
    // Plugin labels must never conceal the bytes that accepting the completion
    // inserts. This is particularly important for serial sessions, where the
    // previewless Enter path can execute a selected suggestion immediately.
    const displayText = text;
    const description = item.description == null ? undefined : boundedString(item.description, 2_048, true);
    if (item.description != null && description == null) continue;
    items.push({
      text,
      displayText,
      ...(description === undefined ? {} : { description }),
      score: finiteScore(item.score),
      providerId,
    });
  }
  return freezeArray(items);
}

export function mergePluginCompletionItems(
  groups: readonly (readonly PluginTerminalCompletionItem[])[],
  maximum: number,
): readonly PluginTerminalCompletionItem[] {
  const seen = new Set<string>();
  const merged = groups.flatMap((group, providerRank) => group.map((item, itemRank) => ({
    item,
    providerRank,
    itemRank,
  })));
  merged.sort((left, right) => right.item.score - left.item.score
    || left.providerRank - right.providerRank
    || left.itemRank - right.itemRank
    || left.item.text.localeCompare(right.item.text));
  const result: PluginTerminalCompletionItem[] = [];
  for (const { item } of merged) {
    if (seen.has(item.text)) continue;
    seen.add(item.text);
    result.push(item);
    if (result.length >= maximum) break;
  }
  return freezeArray(result);
}

interface RegexCharacterDomain {
  readonly any: boolean;
  readonly ascii: ReadonlySet<number>;
  readonly nonAscii: boolean;
}

const anyCharacterDomain = (): RegexCharacterDomain => ({
  any: true,
  ascii: new Set(),
  nonAscii: true,
});

function characterDomain(value: number): RegexCharacterDomain {
  return value <= 0x7f
    ? { any: false, ascii: new Set([value]), nonAscii: false }
    : { any: false, ascii: new Set(), nonAscii: true };
}

function addAsciiRange(target: Set<number>, minimum: number, maximum: number): void {
  for (let value = Math.max(0, minimum); value <= Math.min(0x7f, maximum); value += 1) {
    target.add(value);
  }
}

function characterSetDomain(element: AST.CharacterSet): RegexCharacterDomain {
  if (element.kind === 'any' || element.kind === 'property' || element.negate) {
    return anyCharacterDomain();
  }
  const ascii = new Set<number>();
  if (element.kind === 'digit') {
    addAsciiRange(ascii, 0x30, 0x39);
  } else if (element.kind === 'word') {
    addAsciiRange(ascii, 0x30, 0x39);
    addAsciiRange(ascii, 0x41, 0x5a);
    addAsciiRange(ascii, 0x61, 0x7a);
    ascii.add(0x5f);
  } else {
    for (const value of [0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20]) ascii.add(value);
  }
  return { any: false, ascii, nonAscii: element.kind !== 'digit' };
}

function characterClassDomain(element: AST.CharacterClass): RegexCharacterDomain {
  if (element.negate || element.unicodeSets) return anyCharacterDomain();
  const ascii = new Set<number>();
  let nonAscii = false;
  for (const member of element.elements) {
    if (member.type === 'Character') {
      if (member.value <= 0x7f) ascii.add(member.value);
      else nonAscii = true;
      continue;
    }
    if (member.type === 'CharacterClassRange') {
      addAsciiRange(ascii, member.min.value, member.max.value);
      if (member.max.value > 0x7f) nonAscii = true;
      continue;
    }
    if (member.type === 'CharacterSet') {
      const domain = characterSetDomain(member);
      if (domain.any) return domain;
      for (const value of domain.ascii) ascii.add(value);
      nonAscii ||= domain.nonAscii;
      continue;
    }
    return anyCharacterDomain();
  }
  return { any: false, ascii, nonAscii };
}

function quantifiedAtomDomain(element: AST.QuantifiableElement): RegexCharacterDomain | null {
  if (element.type === 'Character') return characterDomain(element.value);
  if (element.type === 'CharacterSet') return characterSetDomain(element);
  if (element.type === 'CharacterClass') return characterClassDomain(element);
  return null;
}

function domainsOverlap(left: RegexCharacterDomain, right: RegexCharacterDomain): boolean {
  if (left.any || right.any) return true;
  if (left.nonAscii && right.nonAscii) return true;
  for (const value of left.ascii) {
    if (right.ascii.has(value)) return true;
  }
  return false;
}

function elementCanBeEmpty(element: AST.Element): boolean {
  if (element.type === 'Assertion') return true;
  if (element.type === 'Quantifier') return element.min === 0;
  if (element.type === 'Group' || element.type === 'CapturingGroup') {
    return element.alternatives.some((alternative) => alternative.elements.every(elementCanBeEmpty));
  }
  return false;
}

function hasAmbiguousQuantifiedAtoms(pattern: AST.Pattern): boolean {
  let quantifierCount = 0;
  const inspectAlternatives = (alternatives: readonly AST.Alternative[]): boolean => {
    for (const alternative of alternatives) {
      const { elements } = alternative;
      for (const element of elements) {
        if (element.type === 'Group' || element.type === 'CapturingGroup') {
          if (inspectAlternatives(element.alternatives)) return true;
        }
        if (element.type !== 'Quantifier') continue;
        quantifierCount += 1;
        if (quantifierCount > MAX_PLUGIN_PATTERN_QUANTIFIERS) return true;
        // Quantified groups, assertions, and backreferences are deliberately
        // outside the accepted linear-time subset.
        if (!quantifiedAtomDomain(element.element)) return true;
      }
      for (let leftIndex = 0; leftIndex < elements.length; leftIndex += 1) {
        const left = elements[leftIndex];
        if (left.type !== 'Quantifier' || left.max <= 1) continue;
        const leftDomain = quantifiedAtomDomain(left.element);
        if (!leftDomain) return true;
        for (let rightIndex = leftIndex + 1; rightIndex < elements.length; rightIndex += 1) {
          const right = elements[rightIndex];
          if (right.type === 'Quantifier' && right.max > 1) {
            const rightDomain = quantifiedAtomDomain(right.element);
            if (!rightDomain || domainsOverlap(leftDomain, rightDomain)) return true;
          }
          if (!elementCanBeEmpty(right)) break;
        }
      }
    }
    return false;
  };
  return inspectAlternatives(pattern.alternatives);
}

export function isSafePluginDecorationPattern(source: string): boolean {
  if (!(source.length > 0
    && source.length <= 512
    && !/\(\?/u.test(source)
    && !/\\(?:[1-9]|k<)/u.test(source)
    && !/\)(?:[*+?]|\{\d+(?:,\d*)?\})/u.test(source))) return false;
  try {
    const pattern = pluginPatternParser.parsePattern(source, 0, source.length, {
      unicode: true,
      unicodeSets: false,
    });
    if (hasAmbiguousQuantifiedAtoms(pattern)) return false;
    void new RegExp(source, 'u');
    return true;
  } catch {
    return false;
  }
}

export function normalizePluginDecorationResult(
  providerId: string,
  value: unknown,
): readonly PluginTerminalDecorationRule[] {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as { rules?: unknown }
    : null;
  if (!Array.isArray(source?.rules) || source.rules.length > MAX_PLUGIN_DECORATION_RULES) return Object.freeze([]);
  const result: PluginTerminalDecorationRule[] = [];
  const seen = new Set<string>();
  for (const candidate of source.rules) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const rule = candidate as Record<string, unknown>;
    const localId = boundedString(rule.id, 128);
    const label = boundedString(rule.label, 256);
    const color = boundedString(rule.color, 32);
    if (!localId || !label || !color || !/^#[0-9A-Fa-f]{6}(?:[0-9A-Fa-f]{2})?$/u.test(color)) continue;
    if (!Array.isArray(rule.patterns) || rule.patterns.length < 1 || rule.patterns.length > 16) continue;
    const patterns = rule.patterns.filter((pattern): pattern is string => (
      typeof pattern === 'string' && isSafePluginDecorationPattern(pattern)
    ));
    if (patterns.length !== rule.patterns.length) continue;
    const id = `${providerId}:${localId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push({
      id,
      label,
      patterns: Object.freeze([...patterns]),
      color,
      enabled: true,
      providerId,
    });
  }
  return freezeArray(result);
}

export function mergePluginDecorationRules(
  groups: readonly (readonly PluginTerminalDecorationRule[])[],
  maximum = MAX_PLUGIN_DECORATION_RULES,
): readonly PluginTerminalDecorationRule[] {
  const result: PluginTerminalDecorationRule[] = [];
  const seen = new Set<string>();
  for (const group of groups) {
    for (const rule of group) {
      if (seen.has(rule.id)) continue;
      seen.add(rule.id);
      result.push(rule);
      if (result.length >= maximum) return freezeArray(result);
    }
  }
  return freezeArray(result);
}
