"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

const {
  resolveDesktopManagedCli,
} = require("./desktopCliResolver.cjs");

function createFileDeps(files, directories = {}, options = {}) {
  const fileSet = new Set(files);
  const nonExecutable = new Set(options.nonExecutable || []);
  return {
    existsSync: (filePath) => fileSet.has(filePath),
    statSync: (filePath) => ({
      isFile: () => fileSet.has(filePath),
      // mode is only used when accessSync is omitted
      mode: nonExecutable.has(filePath) ? 0o100644 : 0o100755,
    }),
    readdirSync: (directoryPath) => {
      if (!(directoryPath in directories)) throw new Error("ENOENT");
      return directories[directoryPath].map((name) => ({
        name,
        isDirectory: () => true,
      }));
    },
    accessSync: (filePath) => {
      if (!fileSet.has(filePath)) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      if (nonExecutable.has(filePath)) {
        const err = new Error("EACCES");
        err.code = "EACCES";
        throw err;
      }
    },
    X_OK: 1,
  };
}

describe("macOS desktop-managed CLI resolution", () => {
  it("finds the Codex CLI bundled with ChatGPT Desktop", () => {
    const codexPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
    assert.equal(resolveDesktopManagedCli("codex", {
      platform: "darwin",
      homeDir: "/Users/test",
      ...createFileDeps([codexPath]),
    }), codexPath);
  });

  it("finds a user-installed Codex Desktop bundle", () => {
    const codexPath = "/Users/test/Applications/Codex.app/Contents/Resources/codex";
    assert.equal(resolveDesktopManagedCli("codex", {
      platform: "darwin",
      homeDir: "/Users/test",
      ...createFileDeps([codexPath]),
    }), codexPath);
  });

  it("uses the newest valid Claude Code managed by Claude Desktop", () => {
    const root = path.join(
      "/Users/test",
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
    );
    const newestPath = path.join(root, "2.10.0", "claude.app", "Contents", "MacOS", "claude");
    const olderPath = path.join(root, "2.9.9", "claude.app", "Contents", "MacOS", "claude");
    assert.equal(resolveDesktopManagedCli("claude", {
      platform: "darwin",
      homeDir: "/Users/test",
      ...createFileDeps([newestPath, olderPath], {
        [root]: ["2.9.9", "2.10.0"],
      }),
    }), newestPath);
  });

  it("falls back to the newest installed Claude version that has an executable", () => {
    const root = path.join(
      "/Users/test",
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
    );
    const validPath = path.join(root, "2.9.9", "claude.app", "Contents", "MacOS", "claude");
    assert.equal(resolveDesktopManagedCli("claude", {
      platform: "darwin",
      homeDir: "/Users/test",
      ...createFileDeps([validPath], {
        [root]: ["2.10.0", "2.9.9"],
      }),
    }), validPath);
  });

  it("skips newer Claude installs that are not executable and uses an older runnable one", () => {
    const root = path.join(
      "/Users/test",
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
    );
    const newestPath = path.join(root, "2.10.0", "claude.app", "Contents", "MacOS", "claude");
    const olderPath = path.join(root, "2.9.9", "claude.app", "Contents", "MacOS", "claude");
    assert.equal(resolveDesktopManagedCli("claude", {
      platform: "darwin",
      homeDir: "/Users/test",
      ...createFileDeps([newestPath, olderPath], {
        [root]: ["2.10.0", "2.9.9"],
      }, { nonExecutable: [newestPath] }),
    }), olderPath);
  });

  it("skips non-executable Codex desktop candidates", () => {
    const systemPath = "/Applications/ChatGPT.app/Contents/Resources/codex";
    const userPath = "/Users/test/Applications/Codex.app/Contents/Resources/codex";
    assert.equal(resolveDesktopManagedCli("codex", {
      platform: "darwin",
      homeDir: "/Users/test",
      ...createFileDeps([systemPath, userPath], {}, { nonExecutable: [systemPath] }),
    }), userPath);
  });

  it("ignores the plain version/claude helper (Linux VM binary on current installs)", () => {
    const root = path.join(
      "/Users/test",
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
    );
    const linuxHelper = path.join(root, "2.10.0", "claude");
    const olderAppPath = path.join(root, "2.9.9", "claude.app", "Contents", "MacOS", "claude");
    assert.equal(resolveDesktopManagedCli("claude", {
      platform: "darwin",
      homeDir: "/Users/test",
      ...createFileDeps([linuxHelper, olderAppPath], {
        [root]: ["2.10.0", "2.9.9"],
      }),
    }), olderAppPath);
  });

  it("does not select a plain version/claude helper when no app-bundle CLI exists", () => {
    const root = path.join(
      "/Users/test",
      "Library",
      "Application Support",
      "Claude",
      "claude-code",
    );
    const linuxHelper = path.join(root, "2.10.0", "claude");
    assert.equal(resolveDesktopManagedCli("claude", {
      platform: "darwin",
      homeDir: "/Users/test",
      ...createFileDeps([linuxHelper], {
        [root]: ["2.10.0"],
      }),
    }), null);
  });

  it("does not probe desktop locations on other platforms", () => {
    assert.equal(resolveDesktopManagedCli("codex", {
      platform: "linux",
      homeDir: "/home/test",
      ...createFileDeps(["/Applications/ChatGPT.app/Contents/Resources/codex"]),
    }), null);
  });
});
