import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const runtimeSource = readFileSync(new URL("./createXTermRuntime.ts", import.meta.url), "utf8");
const attachmentSource = readFileSync(new URL("./terminalSessionAttachment.ts", import.meta.url), "utf8");
const terminalSource = readFileSync(new URL("../../Terminal.tsx", import.meta.url), "utf8");
const preloadSource = readFileSync(
  new URL("../../../electron/preload/api.cjs", import.meta.url),
  "utf8",
);

test("password-prompt input is classified before prompt state reset and cannot broadcast", () => {
  assert.match(
    attachmentSource,
    /meta\?\.pluginPipelineSensitiveInput === true[\s\S]*?passwordPromptActiveRef\.current = true/u,
  );
  assert.match(
    terminalSource,
    /meta\?\.pluginPipelineSensitiveInput === true[\s\S]*?passwordPromptActiveRef\.current = true[\s\S]*?else if \(isUntrustedTerminalInputPrompt/u,
  );
  assert.match(
    runtimeSource,
    /const sensitive = ctx\.passwordPromptActiveRef\?\.current === true;[\s\S]*?const willBroadcastInput = !sensitive &&/u,
  );
  assert.match(
    runtimeSource,
    /writeToSession\(id, outData, \{ sensitive \}\)/u,
  );
  assert.match(
    runtimeSource,
    /writeToSession\(id, nextData, \{ sensitive \}\)/u,
  );
});

test("confirmed sudo credentials and preload transport preserve the sensitive marker", () => {
  assert.match(
    attachmentSource,
    /writeToSession\(id, data, \{ automated: true, sensitive: true \}\)/u,
  );
  assert.match(preloadSource, /sensitive: options\?\.sensitive === true/u);
});

test("renderer flow control acknowledges host ingress rather than transformed display length", () => {
  assert.match(
    attachmentSource,
    /const pluginPipelineIngressBytes = Number\.isFinite\(meta\?\.pluginPipelineIngressBytes\)[\s\S]*?const ingressBytes = pluginPipelineIngressBytes[\s\S]*?\?\? filtered\.acceptedBytes/u,
  );
  assert.match(
    attachmentSource,
    /filtered\.accepted && !filtered\.data && pluginPipelineIngressBytes != null[\s\S]*?acknowledgeDroppedTerminalDisplayBytes\(ctx, pluginPipelineIngressBytes\)/u,
  );
  assert.match(
    attachmentSource,
    /!filtered\.accepted && pluginPipelineIngressBytes != null[\s\S]*?\? pluginPipelineIngressBytes[\s\S]*?: pluginPipelineIngressBytes != null[\s\S]*?\? 0[\s\S]*?: filtered\.droppedBytes/u,
  );
});
