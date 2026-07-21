"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createScriptRuntime,
  wrapScriptSource,
  interruptibleSleep,
  normalizeDialogFormSpec,
} = require("./scriptRuntime.cjs");
const { SessionOutputBuffer } = require("./sessionOutputBuffer.cjs");

test("wrapScriptSource wraps async main scripts in async IIFE", () => {
  const wrapped = wrapScriptSource(`
// generated
async function main() {
  await nct.log('hi');
}

await main();
`);
  assert.match(wrapped, /^\(async \(\) => \{/);
  assert.match(wrapped, /await main\(\);\n\}\)\(\);$/);
});

test("wrapScriptSource wraps bare statements in async IIFE", () => {
  const wrapped = wrapScriptSource("await nct.log('hi');");
  assert.match(wrapped, /async \(\) =>/);
});

test("interruptibleSleep rejects when aborted", async () => {
  let aborted = false;
  const pending = interruptibleSleep(5000, () => aborted);
  setTimeout(() => {
    aborted = true;
  }, 50);
  await assert.rejects(pending, /Script stopped/);
});

test("createScriptRuntime executes async main script", async () => {
  const logs = [];
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: (_id, message) => logs.push(message),
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => true,
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: () => {},
  });

  await runtime.execute(`
async function main() {
  nct.log('from-main');
}

await main();
`);
  assert.deepEqual(logs, ["from-main"]);
});

test("createScriptRuntime executes simple log script", async () => {
  const logs = [];
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: (_id, message) => logs.push(message),
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => true,
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: () => {},
  });

  await runtime.execute("nct.log('hello');");
  assert.deepEqual(logs, ["hello"]);
});

test("sensitive script input is masked in UI and logs and remains host-bypassed", async () => {
  const logs = [];
  const writes = [];
  const dialogs = [];
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r-sensitive",
    appendLog: (_id, message) => logs.push(message),
    writeToSession: (sessionId, data, options) => writes.push({ sessionId, data, options }),
    getOutputBuffer: () => ({
      getText: () => "",
      consumeThroughAbsolute() {},
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async (...args) => {
      dialogs.push(args);
      return "super-secret";
    },
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: () => {},
  });

  await runtime.execute(`
    const value = await nct.dialog.prompt("Secret", "", { sensitive: true });
    await nct.screen.sendLine(value, { sensitive: true });
  `);

  assert.deepEqual(dialogs[0], ["prompt", "Secret", "", { sensitive: true }]);
  assert.deepEqual(writes, [
    {
      sessionId: "s1",
      data: "super-secret",
      options: { automated: true, sensitive: true, invalidateStartupSeed: false },
    },
    {
      sessionId: "s1",
      data: "\r",
      options: { automated: true, sensitive: true, invalidateStartupSeed: false },
    },
  ]);
  assert.equal(logs.some((entry) => entry.includes("super-secret")), false);
  assert.equal(logs.some((entry) => entry.includes("[sensitive]")), true);
});

test("createScriptRuntime supports regex waits over multiline output", async () => {
  const logs = [];
  const buffer = new SessionOutputBuffer("s1");
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: (_id, message) => logs.push(message),
    writeToSession: () => {},
    getOutputBuffer: () => buffer,
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => true,
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: () => {},
  });

  const run = runtime.execute(`
    await nct.screen.waitForRegex(".*SSH资源.*登录方式.*", 1000);
    nct.log("matched");
  `);
  buffer.append("1. SSH资源\n请选择SSH资源\n'zxadmin'登录方式:");

  await run;
  assert.deepEqual(logs, ["matched"]);
});

test("createScriptRuntime reports activity labels for loops without X/Y totals", async () => {
  const statuses = [];
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: () => {},
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => true,
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: (_id, patch) => statuses.push(patch),
  });

  await runtime.execute("for (let i = 0; i < 3; i += 1) { nct.log(`step ${i}`); }");

  const last = statuses.at(-1);
  assert.equal(last.stepIndex, 3);
  assert.equal(last.activityLabel, "log");
  assert.equal(last.progressMode, "activity");
  assert.equal(last.totalSteps, undefined);
  assert.equal(last.currentStep, "log");
});

test("createScriptRuntime supports explicit determinate progress API", async () => {
  const statuses = [];
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: () => {},
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => true,
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: (_id, patch) => statuses.push(patch),
  });

  await runtime.execute(`
    nct.progress.start('Sampling', 3);
    for (let i = 0; i < 3; i += 1) {
      nct.progress.step('item ' + i);
    }
    nct.progress.done();
    nct.log('finished');
  `);

  const during = statuses.find((patch) => patch.progressMode === "determinate" && patch.progressCurrent === 2);
  assert.ok(during);
  assert.equal(during.progressLabel, "Sampling");
  assert.equal(during.progressTotal, 3);
  assert.equal(during.activityLabel, "item 1");

  const afterDone = statuses.filter((patch) => patch.progressMode === "activity").at(-1);
  assert.ok(afterDone);
  assert.equal(afterDone.progressCurrent, undefined);
  assert.equal(afterDone.progressTotal, undefined);
});

test("normalizeDialogFormSpec normalizes fields and default choice values", () => {
  const form = normalizeDialogFormSpec({
    title: "Deploy",
    message: "Choose options",
    fields: [
      {
        type: "select",
        name: "env",
        label: "Environment",
        options: [
          { label: "Prod", value: "prod", disabled: true },
          "dev",
        ],
        defaultValue: "prod",
      },
      {
        type: "checkbox",
        name: "restart",
        label: "Restart",
        defaultValue: 1,
      },
      {
        type: "radio",
        name: "mode",
        label: "Mode",
        options: [{ label: "Safe", value: "safe", description: "Recommended" }],
      },
      {
        type: "textarea",
        name: "notes",
        label: "Notes",
        defaultValue: 123,
        required: false,
      },
      {
        type: "number",
        name: "retries",
        label: "Retries",
        defaultValue: "3",
        min: "0",
        step: "1",
        visibleWhen: { field: "restart", equals: true },
      },
    ],
  });

  assert.equal(form.title, "Deploy");
  assert.equal(form.message, "Choose options");
  assert.equal(form.fields[0].defaultValue, "dev");
  assert.deepEqual(form.fields[0].options[1], {
    label: "dev",
    value: "dev",
    description: undefined,
    disabled: false,
  });
  assert.equal(form.fields[1].defaultValue, true);
  assert.equal(form.fields[1].required, false);
  assert.equal(form.fields[2].defaultValue, "safe");
  assert.equal(form.fields[3].defaultValue, "123");
  assert.equal(form.fields[3].required, false);
  assert.equal(form.fields[4].defaultValue, 3);
  assert.equal(form.fields[4].min, 0);
  assert.equal(form.fields[4].step, 1);
  assert.deepEqual(form.fields[4].visibleWhen, { field: "restart", equals: true });
});

test("normalizeDialogFormSpec rejects invalid fields", () => {
  assert.throws(
    () => normalizeDialogFormSpec({ fields: [{ type: "checkbox", name: "", label: "Missing name" }] }),
    /field name is required/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({
      fields: [
        { type: "checkbox", name: "same", label: "One" },
        { type: "checkbox", name: "same", label: "Two" },
      ],
    }),
    /Duplicate dialog form field name: same/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({ fields: [{ type: "checkbox", name: "__proto__", label: "Reserved" }] }),
    /field name is reserved: __proto__/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({ fields: [{ type: "select", name: "env", label: "Env", options: [] }] }),
    /requires at least one option/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({ fields: [{ type: "select", name: "env", label: "Env", options: [""] }] }),
    /option value is required/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({ fields: [{ type: "select", name: "env", label: "Env", options: ["dev", { label: "Dev again", value: "dev" }] }] }),
    /option values must be unique: dev/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({
      fields: [{
        type: "radio",
        name: "mode",
        label: "Mode",
        options: [{ label: "Safe", value: "safe", disabled: true }],
      }],
    }),
    /requires at least one enabled option/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({
      fields: [{ type: "number", name: "count", label: "Count", defaultValue: "many" }],
    }),
    /defaultValue must be a finite number/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({
      fields: [{ type: "number", name: "count", label: "Count", min: 10, max: 1 }],
    }),
    /min cannot be greater than max/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({
      fields: [
        { type: "select", name: "target", label: "Target", options: ["local", "remote"] },
        { type: "textarea", name: "host", label: "Host", visibleWhen: { field: "missing", equals: "remote" } },
      ],
    }),
    /visibleWhen references unknown field: missing/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({
      fields: [
        { type: "select", name: "target", label: "Target", options: ["local", "remote"] },
        { type: "textarea", name: "host", label: "Host", visibleWhen: { field: "target", equals: "remote", truthy: true } },
      ],
    }),
    /requires exactly one condition operator/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({
      fields: [
        { type: "textarea", name: "host", label: "Host", visibleWhen: { field: "target", equals: "remote" } },
        { type: "select", name: "target", label: "Target", options: ["local", "remote"] },
      ],
    }),
    /visibleWhen must reference an earlier field: host/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({
      fields: [{ type: "checkbox", name: "self", label: "Self", visibleWhen: { field: "self", truthy: true } }],
    }),
    /visibleWhen must reference an earlier field: self/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({
      fields: [{ type: "number", name: "count", label: "Count", defaultValue: -1, min: 0 }],
    }),
    /defaultValue cannot be less than min/,
  );
  assert.throws(
    () => normalizeDialogFormSpec({
      fields: [{ type: "number", name: "count", label: "Count", defaultValue: 6, min: 1, step: 2 }],
    }),
    /defaultValue must match step from min/,
  );
});

test("createScriptRuntime exposes form dialog API through showDialog", async () => {
  let dialogCall;
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: () => {},
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async (type, message, defaultValue, extras) => {
      dialogCall = { type, message, defaultValue, extras };
      return { env: "prod", restart: true };
    },
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: () => {},
  });

  await runtime.execute(`
    const values = await nct.dialog.form({
      message: 'Deploy?',
      fields: [
        { type: 'select', name: 'env', label: 'Environment', options: ['dev', 'prod'], defaultValue: 'prod' },
        { type: 'checkbox', name: 'restart', label: 'Restart', defaultValue: false },
      ],
    });
    nct.log(values.env + ':' + values.restart);
  `);

  assert.equal(dialogCall.type, "form");
  assert.equal(dialogCall.message, "Deploy?");
  assert.equal(dialogCall.defaultValue, undefined);
  assert.equal(dialogCall.extras.form.fields[0].defaultValue, "prod");
});

test("createScriptRuntime convenience dialog controls return single values", async () => {
  const results = [
    { value: "prod" },
    { value: "safe" },
    { value: true },
  ];
  const calls = [];
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: () => {},
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async (type, message, _defaultValue, extras) => {
      calls.push({ type, message, fieldType: extras.form.fields[0].type });
      return results.shift();
    },
    isPaused: () => false,
    isAborted: () => false,
    onStatusChange: () => {},
  });

  const values = [];
  runtime.nct.log = (message) => values.push(message);
  await runtime.execute(`
    nct.log(await nct.dialog.select('Environment', ['dev', 'prod'], 'dev'));
    nct.log(await nct.dialog.radio('Mode', ['safe', 'fast'], 'safe'));
    nct.log(String(await nct.dialog.checkbox('Restart', true)));
  `);

  assert.deepEqual(calls.map((call) => call.fieldType), ["select", "radio", "checkbox"]);
  assert.deepEqual(values, ["prod", "safe", "true"]);
});

test("createScriptRuntime does not open dialogs after a script is stopped", async () => {
  let aborted = false;
  let dialogCalls = 0;
  const runtime = createScriptRuntime({
    sessionId: "s1",
    runId: "r1",
    appendLog: () => {},
    writeToSession: () => {},
    getOutputBuffer: () => ({
      waitFor: async () => "ok",
      waitForAny: async () => 0,
      getText: () => "",
    }),
    getSessionMeta: () => ({ connected: true, hostname: "host", username: "user" }),
    showDialog: async () => {
      dialogCalls += 1;
      return true;
    },
    isPaused: () => false,
    isAborted: () => aborted,
    onStatusChange: () => {},
  });

  const run = runtime.execute(`
    try {
      await nct.sleep(5000);
    } catch {
      await nct.dialog.confirm('still there?');
    }
  `);
  setTimeout(() => {
    aborted = true;
  }, 30);

  await assert.rejects(run, /Script stopped/);
  assert.equal(dialogCalls, 0);
});
