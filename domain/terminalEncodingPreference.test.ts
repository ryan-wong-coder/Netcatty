import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveInitialTerminalEncoding,
  resolveTerminalEncodingFromCharset,
  terminalEncodingPreferenceToCharset,
} from "./terminalEncodingPreference";

test("resolves GB18030-compatible charset labels", () => {
  assert.equal(resolveTerminalEncodingFromCharset("GB18030"), "gb18030");
  assert.equal(resolveTerminalEncodingFromCharset("GBK"), "gb18030");
  assert.equal(resolveTerminalEncodingFromCharset("zh_CN.GB18030"), "gb18030");
  assert.equal(resolveTerminalEncodingFromCharset("zh_CN.GBK@variant"), "gb18030");
});

test("resolves UTF-8 charset labels", () => {
  assert.equal(resolveTerminalEncodingFromCharset("UTF-8"), "utf-8");
  assert.equal(resolveTerminalEncodingFromCharset("en_US.UTF-8"), "utf-8");
});

test("remembered terminal encoding wins for supported or empty host charsets", () => {
  assert.equal(resolveInitialTerminalEncoding("UTF-8", "gb18030"), "gb18030");
  assert.equal(resolveInitialTerminalEncoding(undefined, "gb18030"), "gb18030");
});

test("saved GB18030 host charset wins over remembered UTF-8", () => {
  assert.equal(resolveInitialTerminalEncoding("GB18030", "utf-8"), "gb18030");
});

test("unsupported charsets ignore remembered encoding", () => {
  assert.equal(resolveInitialTerminalEncoding("latin1", "gb18030"), "utf-8");
});

test("maps terminal encoding preferences back to host charset labels", () => {
  assert.equal(terminalEncodingPreferenceToCharset("utf-8"), "UTF-8");
  assert.equal(terminalEncodingPreferenceToCharset("gb18030"), "GB18030");
});
