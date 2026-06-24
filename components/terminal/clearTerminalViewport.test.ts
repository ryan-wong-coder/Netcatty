import assert from "node:assert/strict";
import test from "node:test";

import { shouldPreserveViewportBeforeFullErase } from "./clearTerminalViewport.ts";

const createMockTerm = (bufferType: "normal" | "alternate"): { buffer: { active: { type: "normal" | "alternate" } } } => ({
  buffer: {
    active: {
      type: bufferType,
    },
  },
});

test("preserves viewport before full erase on the normal screen outside sync blocks", () => {
  const term = createMockTerm("normal");
  assert.equal(shouldPreserveViewportBeforeFullErase(term as never, false), true);
});

test("skips viewport preservation inside DEC 2026 sync blocks", () => {
  const term = createMockTerm("normal");
  assert.equal(shouldPreserveViewportBeforeFullErase(term as never, true), false);
});

test("skips viewport preservation on the alternate screen", () => {
  const term = createMockTerm("alternate");
  assert.equal(shouldPreserveViewportBeforeFullErase(term as never, false), false);
});
