"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  terminalInterceptorChoiceLabel,
  terminalInterceptorIdentifier,
  terminalInterceptorMessages,
} = require("./terminalInterceptorMessages.cjs");

test("terminal interceptor native prompts cover every application locale and fall back to English", () => {
  for (const locale of ["en", "zh-CN", "zh-TW", "ru"]) {
    const messages = terminalInterceptorMessages(locale);
    assert.ok(messages.noInterceptor);
    assert.ok(messages.selectTitle("input"));
    assert.ok(messages.selectMessage("output"));
    assert.ok(messages.warningTitle);
  }
  assert.equal(terminalInterceptorMessages("fr").noInterceptor, "No interceptor");
});

test("plugin-controlled native selection labels visibly escape control and bidi text", () => {
  assert.equal(terminalInterceptorChoiceLabel({
    pluginDisplayName: "safe\nname\u202e",
    provider: { label: "input\tfilter" },
  }), "safe\\nname\\u202e: input\\tfilter");
  assert.equal(terminalInterceptorIdentifier("provider\r\u2066"), "provider\\r\\u2066");
});
