const test = require("node:test");
const assert = require("node:assert/strict");

const {
  createKeyboardInteractiveHandler,
  createOrderedStringAuthHandler,
  isAutoFillablePasswordChallenge,
  shouldPrefillSavedPassword,
  buildAuthHandler,
} = require("./sshAuthHelper.cjs");
const keyboardInteractiveHandler = require("./keyboardInteractiveHandler.cjs");

const createSender = () => {
  const sent = [];
  return {
    sent,
    sender: {
      id: 42,
      isDestroyed: () => false,
      send: (channel, payload) => sent.push({ channel, payload }),
    },
  };
};

// Settles any modal requests that the handler queued via storeRequest so the
// 5-minute TTL timer doesn't keep the test process alive.
const drainPendingRequests = (sent, senderId = 42) => {
  for (const event of sent) {
    if (event.channel !== "netcatty:keyboard-interactive") continue;
    const requestId = event.payload?.requestId;
    if (requestId) {
      keyboardInteractiveHandler.handleResponse({ sender: { id: senderId } }, { requestId, cancelled: true });
    }
  }
};

const passwordPrompt = { prompt: "Password:", echo: false };
const linuxPasswordPrompt = { prompt: "[sudo] password for alice:", echo: false };
const verificationCodePrompt = { prompt: "Verification code:", echo: true };
const otpPrompt = { prompt: "Verification code:", echo: false }; // Google Auth / TOTP
const duoPrompt = { prompt: "Duo two-factor login\nPasscode or option (1-1):", echo: false };
const cjkPasswordPrompt = { prompt: "密码：", echo: false };
const customizedAuthPrompt = { prompt: "Please authenticate:", echo: false };
// OTP prompts that DO mention the word "password" or "口令" — the literal
// keyword should not be enough to trigger auto-fill (#969 PR review round 2).
const oneTimePasswordPrompt = { prompt: "Enter your one-time password:", echo: false };
const cjkDynamicPasswordPrompt = { prompt: "动态密码：", echo: false };
const cjkDynamicTokenPrompt = { prompt: "动态口令：", echo: false };
const cjkOneTimePasswordPrompt = { prompt: "一次性密码：", echo: false };

// --- isAutoFillablePasswordChallenge ---------------------------------------

test("isAutoFillablePasswordChallenge accepts a single hidden-echo prompt with a saved password", () => {
  assert.equal(isAutoFillablePasswordChallenge([passwordPrompt], "hunter2"), true);
});

test("isAutoFillablePasswordChallenge rejects multi-prompt challenges (likely 2FA)", () => {
  assert.equal(
    isAutoFillablePasswordChallenge([passwordPrompt, verificationCodePrompt], "hunter2"),
    false,
  );
});

test("isAutoFillablePasswordChallenge rejects echo=true prompts (could be username / OTP)", () => {
  assert.equal(isAutoFillablePasswordChallenge([verificationCodePrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge rejects when no saved password is available", () => {
  assert.equal(isAutoFillablePasswordChallenge([passwordPrompt], ""), false);
  assert.equal(isAutoFillablePasswordChallenge([passwordPrompt], undefined), false);
  assert.equal(isAutoFillablePasswordChallenge([passwordPrompt], null), false);
});

test("isAutoFillablePasswordChallenge rejects empty / non-array prompts", () => {
  assert.equal(isAutoFillablePasswordChallenge([], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge(undefined, "hunter2"), false);
});

test("isAutoFillablePasswordChallenge rejects OTP-style hidden prompts (Google Authenticator, TOTP)", () => {
  // Single prompt, echo=false, but the text says "Verification code" — that's
  // a 2FA challenge, not a password. Submitting the saved password here would
  // burn an auth attempt on the server. (#969 PR review)
  assert.equal(isAutoFillablePasswordChallenge([otpPrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge rejects Duo-style passcode prompts", () => {
  // "Passcode" is the term Duo uses for the OTP, not a reusable password.
  // Treat it as a 2FA challenge.
  assert.equal(isAutoFillablePasswordChallenge([duoPrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge accepts CJK password prompts", () => {
  // PAM on Chinese-locale Linux often renders "密码：" — the user still
  // expects the saved password to work.
  assert.equal(isAutoFillablePasswordChallenge([cjkPasswordPrompt], "hunter2"), true);
});

test("isAutoFillablePasswordChallenge falls through to the modal for unrecognized prompt text", () => {
  // Custom prompts that don't mention a known keyword stay on the safe side
  // — the user sees the modal as before. No regression from the old
  // always-prompt baseline.
  assert.equal(isAutoFillablePasswordChallenge([customizedAuthPrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge rejects 'One-time password' even though it contains the word 'password'", () => {
  // PR review round 2: the OTP vocabulary check must run before the password
  // keyword check, otherwise "password" in "One-time password" triggers a
  // false-positive auto-fill that burns a 2FA attempt.
  assert.equal(isAutoFillablePasswordChallenge([oneTimePasswordPrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge rejects Chinese OTP prompts ('动态密码', '动态口令', '一次性密码')", () => {
  // The Chinese "动态密码" / "动态口令" / "一次性密码" idioms specifically
  // mean OTP. Mustn't auto-fill the reusable password into them.
  assert.equal(isAutoFillablePasswordChallenge([cjkDynamicPasswordPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([cjkDynamicTokenPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([cjkOneTimePasswordPrompt], "hunter2"), false);
});

test("isAutoFillablePasswordChallenge accepts a sudo-style password prompt", () => {
  // Regression guard: the OTP deny-list should not over-block normal Linux
  // PAM prompts that legitimately mention a username after "password".
  assert.equal(isAutoFillablePasswordChallenge([linuxPasswordPrompt], "hunter2"), true);
});

// Corporate EDR / bastion step-up password prompts (#2150). These contain the
// word "密码" / "password" but must never be auto-filled with the login password.
const secondaryPasswordPrompt = { prompt: "二次密码:", echo: false };
const secondaryAuthPasswordPrompt = { prompt: "请输入二次认证密码", echo: false };
const securityPasswordPrompt = { prompt: "安全密码：", echo: false };
const secondaryPasswordEnPrompt = { prompt: "Secondary password:", echo: false };
const secondPasswordEnPrompt = { prompt: "Second password:", echo: false };

test("isAutoFillablePasswordChallenge rejects EDR secondary password prompts (#2150)", () => {
  assert.equal(isAutoFillablePasswordChallenge([secondaryPasswordPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([secondaryAuthPasswordPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([securityPasswordPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([secondaryPasswordEnPrompt], "hunter2"), false);
  assert.equal(isAutoFillablePasswordChallenge([secondPasswordEnPrompt], "hunter2"), false);
});

// Real-world EDR banner from issue #2150 / reporter screenshot: Chinese
// instruction + English "Secondary Authentication Password:" field label.
const edrSecondaryAuthPasswordPrompt = {
  prompt: "Secondary Authentication Password:",
  echo: false,
};
const edrSecondaryAuthInstructions =
  "为保障主机安全，请输入二次认证密码，如有疑问，请联系xxx，电话xxx。";

test("isAutoFillablePasswordChallenge rejects Secondary Authentication Password (#2150)", () => {
  // English field label alone must not auto-fill — words between "Secondary"
  // and "Password" are common in corporate EDR prompts.
  assert.equal(
    isAutoFillablePasswordChallenge([edrSecondaryAuthPasswordPrompt], "hunter2"),
    false,
  );
});

test("isAutoFillablePasswordChallenge rejects when 二次认证 is only in instructions (#2150)", () => {
  // Even if the prompt field were a generic "Password:", the instruction
  // banner carrying "二次认证密码" must still block auto-fill.
  assert.equal(
    isAutoFillablePasswordChallenge(
      [passwordPrompt],
      "hunter2",
      edrSecondaryAuthInstructions,
    ),
    false,
  );
  assert.equal(
    isAutoFillablePasswordChallenge(
      [edrSecondaryAuthPasswordPrompt],
      "hunter2",
      edrSecondaryAuthInstructions,
    ),
    false,
  );
});

// --- createKeyboardInteractiveHandler --------------------------------------

test("createKeyboardInteractiveHandler auto-fills the saved password for a single password prompt", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  const finishCalls = [];
  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push(responses));

  // The handler answered without sending any IPC and without showing a prompt.
  assert.deepEqual(sent, []);
  assert.deepEqual(promptEvents, []);
  assert.deepEqual(autoFillEvents, ["auto-fill"]);
  assert.deepEqual(finishCalls, [["hunter2"]]);
});

test("createKeyboardInteractiveHandler falls back to the modal on the retry after a failed auto-fill", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "wrong-password",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  const finishCalls = [];
  // First call — auto-fill fires, no modal shown.
  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push({ first: responses }));
  // ssh2 re-invokes after auth failure — this time the user must see the modal.
  // savedPassword is intentionally omitted so a multi-round second factor that
  // also says "Password:" cannot re-submit the login secret on Enter (#2150).
  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push({ second: responses }));

  assert.deepEqual(autoFillEvents, ["auto-fill"]);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.deepEqual(finishCalls, [{ first: ["wrong-password"] }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netcatty:keyboard-interactive");
  assert.equal(sent[0].payload.savedPassword, null);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler does not prefill after a prior auto-fill round (#2150)", () => {
  // Multi-round keyboard-interactive without partialSuccess between rounds:
  // round 1 auto-fills the login password; round 2 looks like Password: again
  // (EDR secondary) and must open empty.
  const { sender, sent } = createSender();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
  });

  handler("", "", "", [passwordPrompt], () => {}); // auto-fill
  handler("", "", "", [passwordPrompt], () => {}); // modal, no prefill

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler shows the modal when the challenge is real 2FA (multiple prompts)", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  handler("Two-factor", "", "", [passwordPrompt, verificationCodePrompt], () => {});

  assert.deepEqual(autoFillEvents, []);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.prompts.length, 2);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler includes the request scope in modal payloads", () => {
  const { sender, sent } = createSender();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    scope: "terminal",
  });

  handler("Two-factor", "", "", [passwordPrompt, verificationCodePrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.scope, "terminal");

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler does not auto-fill when no saved password is configured", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: undefined,
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  handler("", "", "", [passwordPrompt], () => {});

  assert.deepEqual(autoFillEvents, []);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler shows the modal for OTP-style hidden prompts even with a saved password", () => {
  // Regression guard for the #969 PR review: a single hidden-echo prompt
  // that doesn't mention "password" must not auto-submit the saved value.
  const { sender, sent } = createSender();
  const autoFillEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
  });

  handler("", "", "", [otpPrompt], () => {});

  assert.deepEqual(autoFillEvents, []);
  assert.equal(sent.length, 1, "modal IPC should fire instead of auto-fill");
  assert.equal(sent[0].channel, "netcatty:keyboard-interactive");

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler short-circuits when the server sends zero prompts", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  const finishCalls = [];
  handler("", "", "", [], (responses) => finishCalls.push(responses));

  assert.deepEqual(autoFillEvents, []);
  assert.deepEqual(promptEvents, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(finishCalls, [[]]);
});

test("createKeyboardInteractiveHandler shows the modal for EDR secondary password prompts (#2150)", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  handler("EDR", "", "", [secondaryPasswordPrompt], () => {});

  assert.deepEqual(autoFillEvents, []);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].channel, "netcatty:keyboard-interactive");
  assert.equal(sent[0].payload.prompts[0].prompt, "二次密码:");

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler skips auto-fill after partialSuccess (#2150)", () => {
  // password method already succeeded as first factor; a later KI challenge
  // that merely says "Password:" must still show the modal so the user can
  // enter the distinct secondary secret.
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const promptEvents = [];
  const authPhase = { hadPartialSuccess: true };

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
    shouldSkipAutoFill: () => authPhase.hadPartialSuccess,
    onAutoFill: () => autoFillEvents.push("auto-fill"),
    onPromptShown: () => promptEvents.push("prompt-shown"),
  });

  handler("", "", "", [passwordPrompt], () => {});

  assert.deepEqual(autoFillEvents, []);
  assert.deepEqual(promptEvents, ["prompt-shown"]);
  assert.equal(sent.length, 1);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler still auto-fills before any partialSuccess", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];
  const authPhase = { hadPartialSuccess: false };

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    password: "hunter2",
    shouldSkipAutoFill: () => authPhase.hadPartialSuccess,
    onAutoFill: () => autoFillEvents.push("auto-fill"),
  });

  const finishCalls = [];
  handler("", "", "", [passwordPrompt], (responses) => finishCalls.push(responses));

  assert.deepEqual(autoFillEvents, ["auto-fill"]);
  assert.deepEqual(finishCalls, [["hunter2"]]);
  assert.deepEqual(sent, []);
});

test("createKeyboardInteractiveHandler omits savedPassword on post-partialSuccess modal (#2150)", () => {
  const { sender, sent } = createSender();
  const authPhase = { hadPartialSuccess: true };

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
    shouldSkipAutoFill: () => authPhase.hadPartialSuccess,
  });

  handler("", "", "", [passwordPrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler omits savedPassword for secondary password prompts", () => {
  const { sender, sent } = createSender();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
  });

  handler("EDR", "", "", [secondaryPasswordPrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);

  drainPendingRequests(sent);
});

test("createOrderedStringAuthHandler sets hadPartialSuccess on partialSuccess", () => {
  const authPhase = { hadPartialSuccess: false };
  const handler = createOrderedStringAuthHandler(
    ["none", "password", "keyboard-interactive"],
    authPhase,
  );

  const offered = [];
  handler(null, false, (method) => offered.push(method)); // none
  handler(["password", "keyboard-interactive"], false, (method) => offered.push(method)); // password
  handler(["keyboard-interactive"], true, (method) => offered.push(method)); // KI after partial

  assert.deepEqual(offered, ["none", "password", "keyboard-interactive"]);
  assert.equal(authPhase.hadPartialSuccess, true);
});

test("buildAuthHandler simple password path tracks partialSuccess via function handler", () => {
  const auth = buildAuthHandler({
    password: "hunter2",
    username: "alice",
    // No default keys / agent: simple explicit password-only path.
    defaultKeys: [],
    allowAgentFallback: false,
  });

  assert.equal(typeof auth.authHandler, "function");
  assert.ok(auth.authPhase);
  assert.equal(auth.authPhase.hadPartialSuccess, false);

  const offered = [];
  auth.authHandler(null, false, (method) => offered.push(method));
  auth.authHandler(["password", "keyboard-interactive"], false, (method) => offered.push(method));
  auth.authHandler(["keyboard-interactive"], true, (method) => offered.push(method));

  assert.ok(offered.includes("password") || offered.some((m) => m === "password" || m?.type === "password"));
  assert.ok(offered.includes("keyboard-interactive"));
  assert.equal(auth.authPhase.hadPartialSuccess, true);
});

test("shouldPrefillSavedPassword is false after skipAutoFill and for secondary prompts", () => {
  assert.equal(
    shouldPrefillSavedPassword([passwordPrompt], "hunter2", { skipAutoFill: true }),
    false,
  );
  assert.equal(
    shouldPrefillSavedPassword([secondaryPasswordPrompt], "hunter2", { skipAutoFill: false }),
    false,
  );
  assert.equal(
    shouldPrefillSavedPassword([passwordPrompt], "hunter2", { skipAutoFill: false }),
    true,
  );
});

test("createKeyboardInteractiveHandler shows modal for Secondary Authentication Password banner (#2150)", () => {
  const { sender, sent } = createSender();
  const autoFillEvents = [];

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "192.168.9.128",
    password: "login-password",
    onAutoFill: () => autoFillEvents.push("auto-fill"),
  });

  handler(
    "Keyboard-interactive authentication prompts from server",
    edrSecondaryAuthInstructions,
    "",
    [edrSecondaryAuthPasswordPrompt],
    () => {},
  );

  assert.deepEqual(autoFillEvents, []);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);
  assert.equal(sent[0].payload.allowSavePassword, false);
  assert.equal(sent[0].payload.prompts[0].prompt, "Secondary Authentication Password:");

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler disables save on post-partialSuccess Password prompt", () => {
  const { sender, sent } = createSender();
  const authPhase = { hadPartialSuccess: true };

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "corp-edr.example.com",
    password: "login-password",
    shouldSkipAutoFill: () => authPhase.hadPartialSuccess,
  });

  handler("", "", "", [passwordPrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.savedPassword, null);
  assert.equal(sent[0].payload.allowSavePassword, false);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler allows save on first-factor password modal", () => {
  const { sender, sent } = createSender();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "vps-1.example.com",
    // No saved password → modal with save checkbox for first login
  });

  handler("", "", "", [passwordPrompt], () => {});

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.allowSavePassword, true);

  drainPendingRequests(sent);
});

test("createKeyboardInteractiveHandler allows save on multi-prompt Password + OTP (#2151 P3)", () => {
  // PAM/Duo style: one keyboard-interactive challenge with a password slot
  // and a verification-code slot. Saving should still target the password
  // field only — do not disable allowSavePassword just because OTP wording
  // appears in another prompt of the same challenge.
  const { sender, sent } = createSender();

  const handler = createKeyboardInteractiveHandler({
    sender,
    sessionId: "session-1",
    hostname: "duo.example.com",
    password: "login-password",
  });

  handler(
    "Two-factor",
    "",
    "",
    [passwordPrompt, verificationCodePrompt],
    () => {},
  );

  assert.equal(sent.length, 1);
  assert.equal(sent[0].payload.allowSavePassword, true);
  // Prefill still OK for the password slot in multi-prompt first-factor forms.
  assert.equal(sent[0].payload.savedPassword, "login-password");

  drainPendingRequests(sent);
});
