"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { PluginCredentialCatalog } = require("./credentialCatalog.cjs");

function encrypted(value) {
  return `enc:v1:${Buffer.from(`cipher:${value}`).toString("base64")}`;
}

test("Vault credential catalog keeps only encrypted opaque references and decrypts on lease consumption", async () => {
  const catalog = new PluginCredentialCatalog({
    safeStorage: {
      isEncryptionAvailable: () => true,
      getSelectedStorageBackend: () => "keychain",
      decryptString: (value) => value.toString().replace(/^cipher:/u, ""),
    },
  });
  assert.equal(catalog.update([{
    id: "credential-reference-0001",
    ciphertext: encrypted("correct horse battery staple"),
  }]), 1);
  await catalog.assertReference({ kind: "credential", id: "credential-reference-0001" });
  assert.equal(
    await catalog.resolve({ kind: "credential", id: "credential-reference-0001" }),
    "correct horse battery staple",
  );
  await assert.rejects(
    catalog.assertReference({ kind: "credential", id: "credential-reference-missing" }),
    /not found/i,
  );
  assert.throws(() => catalog.update([{
    id: "credential-reference-0002",
    ciphertext: "plaintext-secret",
  }]), /OS-backed encryption/i);
});

test("Vault credential catalog fails closed when secure storage is unavailable", async () => {
  const catalog = new PluginCredentialCatalog({
    safeStorage: {
      isEncryptionAvailable: () => false,
      getSelectedStorageBackend: () => "basic_text",
    },
  });
  catalog.update([{
    id: "credential-reference-0001",
    ciphertext: encrypted("secret"),
  }]);
  await assert.rejects(
    catalog.resolve({ kind: "credential", id: "credential-reference-0001" }),
    /unavailable/i,
  );
});
