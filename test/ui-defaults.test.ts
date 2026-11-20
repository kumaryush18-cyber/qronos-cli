import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { ensureUiDefaults, installSmoothScrolling, UI_DEFAULTS } from "../src/ui-defaults";

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

describe("installSmoothScrolling", () => {
  test("auto becomes one line and an explicit number is respected", () => {
    const originalLines = SettingsManager.prototype.getFullscreenWheelScrollLines;
    const originalBar = SettingsManager.prototype.getFullscreenScrollbar;
    installSmoothScrolling();

    // The real resolver reads `this.settings`, so a plain object is enough.
    const auto = { settings: { fullscreenWheelScrollLines: "auto" } };
    const three = { settings: { fullscreenWheelScrollLines: 3 } };
    const big = { settings: { fullscreenWheelScrollLines: 40 } };

    expect(SettingsManager.prototype.getFullscreenWheelScrollLines.call(auto)).toBe(1);
    expect(SettingsManager.prototype.getFullscreenWheelScrollLines.call(three)).toBe(3);
    expect(SettingsManager.prototype.getFullscreenWheelScrollLines.call(big)).toBe(40);
    expect(
      SettingsManager.prototype.getFullscreenScrollbar.call({ settings: { fullscreenScrollbar: "auto" } }),
    ).toBe("always");

    SettingsManager.prototype.getFullscreenWheelScrollLines = originalLines;
    SettingsManager.prototype.getFullscreenScrollbar = originalBar;
  });
});
