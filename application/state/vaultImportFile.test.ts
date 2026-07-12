import assert from "node:assert/strict";
import test from "node:test";

import { importVaultHostsFromText } from "../../domain/vaultImport.ts";
import { readVaultImportFile } from "./vaultImportFile.ts";

const sessionValue = "#109#0%10.0.0.1%22%root";

test("MobaXterm import prefers GB18030 when legacy Chinese bytes are valid UTF-8", async () => {
  const prefix = new TextEncoder().encode("[Bookmarks]\nSubRep=\nImgNum=42\n");
  const suffix = new TextEncoder().encode(`=${sessionValue}`);
  const bytes = new Uint8Array(prefix.length + 2 + suffix.length);
  bytes.set(prefix);
  bytes.set([0xc2, 0xa1], prefix.length);
  bytes.set(suffix, prefix.length + 2);

  const text = await readVaultImportFile(
    "mobaxterm",
    new File([bytes], "MobaXterm.ini", { type: "text/plain" }),
  );
  const result = importVaultHostsFromText("mobaxterm", text);

  assert.equal(result.hosts[0]?.label, "隆");
});

test("MobaXterm import keeps unmarked UTF-8 Chinese text", async () => {
  const text = `[Bookmarks]\nSubRep=\nImgNum=42\n隆=${sessionValue}`;
  const decoded = await readVaultImportFile(
    "mobaxterm",
    new File([text], "MobaXterm.ini", { type: "text/plain" }),
  );
  const result = importVaultHostsFromText("mobaxterm", decoded);

  assert.equal(result.hosts[0]?.label, "隆");
});
