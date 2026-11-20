import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureUiDefaults, UI_DEFAULTS } from "../src/ui-defaults";

function tempAgentDir() {
  return mkdtempSync(join(tmpdir(), "qronos-ui-defaults-"));
}

describe("ensureUiDefaults", () => {
  test("creates settings.json with smooth scrolling defaults", () => {
    const dir = tempAgentDir();
    expect(ensureUiDefaults(dir)).toBe(true);
    const written = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(written.fullscreenScrollbar).toBe("always");
    expect(written.fullscreenWheelScrollLines).toBe(1);
  });

  test("never overwrites a value the user chose", () => {
    const dir = tempAgentDir();
    writeFileSync(
      join(dir, "settings.json"),
      JSON.stringify({ fullscreenWheelScrollLines: 3, theme: "dark" }),
      "utf8",
    );
    ensureUiDefaults(dir);
    const written = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
    expect(written.fullscreenWheelScrollLines).toBe(3);
    expect(written.fullscreenScrollbar).toBe(UI_DEFAULTS.fullscreenScrollbar);
    expect(written.theme).toBe("dark");
  });

  test("is a no-op on the second run", () => {
    const dir = tempAgentDir();
    ensureUiDefaults(dir);
    expect(ensureUiDefaults(dir)).toBe(false);
  });

  test("leaves a non-object settings file alone", () => {
    const dir = tempAgentDir();
    writeFileSync(join(dir, "settings.json"), "[]", "utf8");
    expect(ensureUiDefaults(dir)).toBe(false);
    expect(readFileSync(join(dir, "settings.json"), "utf8")).toBe("[]");
  });
});
