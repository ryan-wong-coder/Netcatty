const test = require("node:test");
const assert = require("node:assert/strict");
const {
  probeClaudeAuth, probeCopilotAuth, probeCodexAuth, probeCodebuddyAuth, probeCursorCliAuth,
} = require("./agentAuthProbes.cjs");

test("probeClaudeAuth: env ANTHROPIC_API_KEY -> authenticated env", () => {
  const r = probeClaudeAuth({
    env: { ANTHROPIC_API_KEY: "sk-x" },
    platform: "darwin",
    runSecurity: () => { throw new Error("should not be called"); },
    fileExists: () => false,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "env");
});

test("probeClaudeAuth: macOS keychain hit -> authenticated keychain", () => {
  const r = probeClaudeAuth({
    env: {},
    platform: "darwin",
    runSecurity: () => ({ exitCode: 0, stdout: '{"claudeAiOauth":{}}' }),
    fileExists: () => false,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "keychain");
});

test("probeClaudeAuth: linux credentials file -> authenticated credentials-file", () => {
  const r = probeClaudeAuth({
    env: {},
    platform: "linux",
    runSecurity: () => { throw new Error("no keychain on linux"); },
    fileExists: (p) => p.endsWith(".credentials.json"),
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "credentials-file");
});

test("probeClaudeAuth: nothing -> not authenticated", () => {
  const r = probeClaudeAuth({
    env: {}, platform: "darwin",
    runSecurity: () => ({ exitCode: 44, stdout: "" }),
    fileExists: () => false,
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCopilotAuth: gh auth status exit 0 -> authenticated gh", () => {
  const r = probeCopilotAuth({ runGhAuthStatus: () => ({ exitCode: 0, stderr: "Logged in to github.com" }) });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "gh");
});

test("probeCopilotAuth: gh auth status non-zero -> not authenticated", () => {
  const r = probeCopilotAuth({ runGhAuthStatus: () => ({ exitCode: 1, stderr: "not logged in" }) });
  assert.equal(r.authenticated, false);
});

test("probeCodexAuth: 'Logged in using ChatGPT' -> authenticated chatgpt", () => {
  const r = probeCodexAuth({
    runLoginStatus: () => ({ exitCode: 0, stdout: "Logged in using ChatGPT" }),
    fileExists: () => false,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "chatgpt");
});

test("probeCodexAuth: auth.json fallback -> authenticated auth-file", () => {
  const r = probeCodexAuth({
    runLoginStatus: () => ({ exitCode: 1, stdout: "not logged in" }),
    fileExists: (p) => p.endsWith("auth.json"),
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "auth-file");
});

// ── CodeBuddy ──
test("probeCodebuddyAuth: CODEBUDDY_API_KEY env -> authenticated api-key", () => {
  const r = probeCodebuddyAuth({
    env: { CODEBUDDY_API_KEY: "cb-key-123" },
    readFile: () => null,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "api-key");
});

test("probeCodebuddyAuth: CODEBUDDY_AUTH_TOKEN env -> authenticated auth-token", () => {
  const r = probeCodebuddyAuth({
    env: { CODEBUDDY_AUTH_TOKEN: "oauth-token-xyz" },
    readFile: () => null,
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "auth-token");
});

test("probeCodebuddyAuth: settings.json with authToken -> authenticated settings-file", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => '{"authToken":"real-token"}',
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "settings-file");
});

test("probeCodebuddyAuth: settings.json with apiKeyHelper -> authenticated settings-file", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => '{"apiKeyHelper":"/usr/local/bin/helper"}',
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "settings-file");
});

test("probeCodebuddyAuth: empty settings.json -> not authenticated", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => "",
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCodebuddyAuth: malformed JSON in settings.json -> not authenticated", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => "{not valid json",
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCodebuddyAuth: settings.json without auth fields -> not authenticated", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => '{"theme":"dark","language":"en"}',
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCodebuddyAuth: no env, no settings file -> not authenticated", () => {
  const r = probeCodebuddyAuth({
    env: {},
    readFile: () => null,
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
});

test("probeCodebuddyAuth: CODEBUDDY_API_KEY takes precedence over settings.json", () => {
  const r = probeCodebuddyAuth({
    env: { CODEBUDDY_API_KEY: "cb-key" },
    readFile: () => '{"authToken":"token"}',
  });
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "api-key");
});

// ── Cursor CLI login ──
test("probeCursorCliAuth: prefers cursor-agent and parses authenticated JSON", () => {
  const calls = [];
  const r = probeCursorCliAuth({
    env: { CURSOR_API_KEY: "should-be-stripped" },
    resolveBinary: (name) => {
      calls.push(name);
      return name === "cursor-agent" ? "/bin/cursor-agent" : null;
    },
    runStatus: (bin) => {
      assert.equal(bin, "/bin/cursor-agent");
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          status: "authenticated",
          isAuthenticated: true,
          userInfo: { email: "user@example.com" },
        }),
      };
    },
  });
  assert.deepEqual(calls, ["cursor-agent"]);
  assert.equal(r.authenticated, true);
  assert.equal(r.authSource, "cli-login");
  assert.equal(r.email, "user@example.com");
  assert.equal(r.binPath, "/bin/cursor-agent");
});

test("probeCursorCliAuth: skips non-Cursor agent then uses cursor-shaped agent binary", () => {
  const statusCalls = [];
  const r = probeCursorCliAuth({
    resolveBinary: (name) => (name === "cursor-agent"
      ? "/usr/local/bin/grok-agent-shim"
      : name === "agent"
        ? "/bin/agent"
        : null),
    runStatus: (bin) => {
      statusCalls.push(bin);
      if (bin.includes("grok")) {
        return { exitCode: 1, stdout: "error: unexpected argument '--format'", stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({ isAuthenticated: true, userInfo: { email: "a@b.c" } }),
      };
    },
  });
  assert.deepEqual(statusCalls, ["/usr/local/bin/grok-agent-shim", "/bin/agent"]);
  assert.equal(r.authenticated, true);
  assert.equal(r.binPath, "/bin/agent");
});

test("probeCursorCliAuth: unauthenticated JSON -> not authenticated but keeps binPath", () => {
  const r = probeCursorCliAuth({
    resolveBinary: (name) => (name === "cursor-agent" ? "/bin/cursor-agent" : null),
    runStatus: () => ({
      exitCode: 0,
      stdout: JSON.stringify({ isAuthenticated: false }),
    }),
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.authSource, null);
  assert.equal(r.binPath, "/bin/cursor-agent");
});

test("probeCursorCliAuth: missing binary -> not authenticated", () => {
  const r = probeCursorCliAuth({
    resolveBinary: () => null,
    runStatus: () => { throw new Error("should not run"); },
  });
  assert.equal(r.authenticated, false);
  assert.equal(r.binPath, null);
});

test("probeCursorCliAuth: status command failure -> not authenticated", () => {
  const r = probeCursorCliAuth({
    resolveBinary: () => "/bin/agent",
    runStatus: () => ({ exitCode: 1, stdout: "", stderr: "boom" }),
  });
  assert.equal(r.authenticated, false);
});
