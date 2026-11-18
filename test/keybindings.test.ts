import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureKeybindingDefaults,
  keybindingsPath,
  mergeKeybindingDefaults,
  QRONOS_KEYBINDING_DEFAULTS,
} from "../src/keybindings";

function tempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "qronos-keybindings-"));
}

describe("qronos keybinding defaults", () => {
  test("Ctrl+C clears nothing and goes nowhere else", () => {
    expect(QRONOS_KEYBINDING_DEFAULTS["app.clear"]).toEqual([]);
    // Escape stays the only interrupt key: Ctrl+C must not be moved to it.
    expect(QRONOS_KEYBINDING_DEFAULTS["app.interrupt"]).toBeUndefined();
  });
});

describe("mergeKeybindingDefaults", () => {
  test("adds the missing keys on an empty config", () => {
    const { config, changed } = mergeKeybindingDefaults(undefined);
    expect(changed).toBe(true);
    expect(config["app.clear"]).toEqual([]);
    expect(config["app.interrupt"]).toBeUndefined();
  });

  test("never overrides a key the user set", () => {
    const { config, changed } = mergeKeybindingDefaults({ "app.clear": "ctrl+k" });
    expect(changed).toBe(false);
    expect(config["app.clear"]).toBe("ctrl+k");
  });

  test("takes Ctrl+C off interrupt for files written by the earlier build", () => {
    const { config, changed } = mergeKeybindingDefaults({
      "app.clear": [],
      "app.interrupt": ["escape", "ctrl+c"],
    });
    expect(changed).toBe(true);
    expect(config["app.interrupt"]).toEqual(["escape"]);
    expect(config["app.clear"]).toEqual([]);
  });

  test("leaves a user's own interrupt binding alone", () => {
    const { config, changed } = mergeKeybindingDefaults({
      "app.clear": [],
      "app.interrupt": ["escape", "ctrl+x"],
    });
    expect(changed).toBe(false);
    expect(config["app.interrupt"]).toEqual(["escape", "ctrl+x"]);
  });

  test("is idempotent once the defaults are present", () => {
    const first = mergeKeybindingDefaults(undefined);
    const second = mergeKeybindingDefaults(first.config);
    expect(second.changed).toBe(false);
    expect(second.config).toEqual(first.config);
  });
});

describe("ensureKeybindingDefaults", () => {
  test("writes keybindings.json when it does not exist", () => {
    const agentDir = tempAgentDir();
    expect(ensureKeybindingDefaults(agentDir)).toBe(true);
    const written = JSON.parse(readFileSync(keybindingsPath(agentDir), "utf8"));
    expect(written["app.clear"]).toEqual([]);
    expect(written["app.interrupt"]).toBeUndefined();
  });

  test("keeps other user bindings and does not rewrite a complete file", () => {
    const agentDir = tempAgentDir();
    const path = keybindingsPath(agentDir);
    writeFileSync(
      path,
      JSON.stringify({ "app.clear": "ctrl+k", "tui.editor.submit": "enter" }),
    );
    expect(ensureKeybindingDefaults(agentDir)).toBe(false);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after["app.clear"]).toBe("ctrl+k");
  });

  test("repairs the Ctrl+C-on-interrupt file from the earlier build", () => {
    const agentDir = tempAgentDir();
    const path = keybindingsPath(agentDir);
    writeFileSync(path, JSON.stringify({ "app.clear": [], "app.interrupt": ["escape", "ctrl+c"] }));
    expect(ensureKeybindingDefaults(agentDir)).toBe(true);
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after["app.interrupt"]).toEqual(["escape"]);
    expect(after["app.clear"]).toEqual([]);
  });

  test("leaves a broken file alone instead of throwing", () => {
    const agentDir = tempAgentDir();
    const path = keybindingsPath(agentDir);
    writeFileSync(path, "{ not json");
    expect(ensureKeybindingDefaults(agentDir)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("{ not json");
  });
});
