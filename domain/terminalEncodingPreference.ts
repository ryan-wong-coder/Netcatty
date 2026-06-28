export type TerminalEncodingPreference = 'utf-8' | 'gb18030';

export const isTerminalEncodingPreference = (
  value: string | null | undefined,
): value is TerminalEncodingPreference => value === 'utf-8' || value === 'gb18030';

const normalizeCharsetToken = (value: string): string => value.replace(/[^a-z0-9]/g, "");

const GB18030_CHARSET_TOKENS = new Set(["gb18030", "gbk", "gb2312", "cp936", "ms936"]);
const UTF8_CHARSET_TOKENS = new Set(["utf8", "utf"]);

export const resolveTerminalEncodingFromCharset = (
  charset?: string,
): TerminalEncodingPreference | null => {
  if (!charset) return null;
  const raw = String(charset).trim().toLowerCase();
  if (!raw) return null;

  const localeCodeset = raw.match(/\.([^@]+)(?:@.*)?$/)?.[1];
  const candidates = [raw, localeCodeset].filter((value): value is string => Boolean(value));
  if (candidates.some((candidate) => GB18030_CHARSET_TOKENS.has(normalizeCharsetToken(candidate)))) {
    return 'gb18030';
  }
  if (candidates.some((candidate) => UTF8_CHARSET_TOKENS.has(normalizeCharsetToken(candidate)))) {
    return 'utf-8';
  }
  return null;
};

export const resolveInitialTerminalEncoding = (
  charset?: string,
  rememberedEncoding?: string | null,
): TerminalEncodingPreference => {
  const charsetEncoding = resolveTerminalEncodingFromCharset(charset);
  const remembered = isTerminalEncodingPreference(rememberedEncoding) ? rememberedEncoding : null;

  if (charsetEncoding === 'gb18030') return charsetEncoding;

  if (remembered && (charsetEncoding !== null || !String(charset ?? "").trim())) {
    return remembered;
  }

  return charsetEncoding ?? 'utf-8';
};

export const terminalEncodingPreferenceToCharset = (
  encoding: TerminalEncodingPreference,
): string => (encoding === 'gb18030' ? 'GB18030' : 'UTF-8');
