import type { VaultImportFormat } from "../../domain/vaultImport";
import { readTextFile } from "../../lib/readTextFile";

const countMatches = (text: string, pattern: RegExp): number =>
  Array.from(text.matchAll(pattern)).length;

const scoreMobaXtermDecodedText = (text: string): number => {
  const cjkCharacters = countMatches(text, /\p{Script=Han}/gu);
  const invalidCharacters = countMatches(
    text,
    /[\u0080-\u009f\ue000-\uf8ff\u{f0000}-\u{ffffd}\u{100000}-\u{10fffd}\ufffd]/gu,
  );
  return cjkCharacters - invalidCharacters * 100;
};

const selectMobaXtermDecodedText = ({
  utf8,
  fallback,
}: {
  utf8: string;
  fallback: string;
}): string =>
  scoreMobaXtermDecodedText(fallback) > scoreMobaXtermDecodedText(utf8)
    ? fallback
    : utf8;

export const readVaultImportFile = (
  format: VaultImportFormat,
  file: File,
): Promise<string> =>
  readTextFile(file, {
    fallbackEncoding: format === "mobaxterm" ? "gb18030" : undefined,
    selectDecodedText: format === "mobaxterm" ? selectMobaXtermDecodedText : undefined,
  });
