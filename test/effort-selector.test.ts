import { describe, expect, test } from "bun:test";
import { ClaudeEffortSelectorComponent, installEffortHandler } from "../src/effort-selector";

describe("ClaudeEffortSelectorComponent", () => {
  test("renders horizontal effort slider with Claude Code styling", () => {
    const selected: Array<{ level: string; persist: boolean }> = [];
    let cancelled = false;
    let ultracodeToggled = false;

    const component = new ClaudeEffortSelectorComponent({
      currentLevel: "medium",
      availableLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      onSelect: (level, persist) => selected.push({ level, persist }),
      onCancel: () => {
        cancelled = true;
      },
      onToggleUltracode: (enabled) => {
        ultracodeToggled = enabled;
      },
    });

    const lines = component.render(80);
    const fullText = lines.join("\n");

    // Must have Claude Code effort headers & track elements
    expect(fullText).toContain("Effort");
    expect(fullText).toContain("Faster");
    expect(fullText).toContain("Smarter");
    expect(fullText).toContain("▲");
    expect(fullText).toContain("Ultracode");
    expect(fullText).toContain("Tab to toggle");
    expect(fullText).toContain("←/→ to adjust");
    expect(fullText).toContain("Enter to confirm");
    expect(fullText).toContain("s for session only");
    expect(fullText).toContain("Esc to cancel");

    // Test navigation: moving right to high
    component.handleInput("\u001b[C"); // right arrow
    const afterRight = component.render(80).join("\n");
    expect(afterRight).toContain("planning and deep codebase analysis");

    // Test toggle ultracode with Tab
    component.handleInput("\t");
    expect(ultracodeToggled).toBe(false);

    // Test persist select with Enter
    component.handleInput("\r");
    expect(selected).toEqual([{ level: "high", persist: true }]);

    // Test session-only select with 's'
    component.handleInput("s");
    expect(selected).toEqual([
      { level: "high", persist: true },
      { level: "high", persist: false },
    ]);

    // Test cancel with Escape
    component.handleInput("\u001b");
    expect(cancelled).toBe(true);
  });

  test("installEffortHandler overrides showThinkingSelector and cycleThinkingLevel", () => {
    let thinkingSelectorOpened = false;

    const fakeMode: any = {
      session: {
        thinkingLevel: "medium",
        getAvailableThinkingLevels: () => ["low", "medium", "high", "max"],
      },
      showSelector: (fn: any) => {
        thinkingSelectorOpened = true;
        return fn(() => {});
      },
      showStatus: (msg: string) => msg,
    };

    installEffortHandler(fakeMode);

    // Verify showThinkingSelector opens our Claude effort component
    const res = fakeMode.showThinkingSelector();
    expect(thinkingSelectorOpened).toBe(true);
    expect(res.component instanceof ClaudeEffortSelectorComponent).toBe(true);

    // Verify cycleThinkingLevel (Shift+Tab) does NOT cycle thinking level
    fakeMode.cycleThinkingLevel();
    expect(fakeMode.session.thinkingLevel).toBe("medium");
  });

  test("never exceeds terminal width even on narrow mobile terminals (width = 56)", () => {
    const { visibleWidth } = require("@earendil-works/pi-tui");
    const component = new ClaudeEffortSelectorComponent({
      currentLevel: "off",
      availableLevels: ["off", "low", "medium", "high", "xhigh", "max"],
      onSelect: () => {},
      onCancel: () => {},
    });

    for (const testWidth of [40, 50, 56, 60, 70, 80]) {
      const rendered = component.render(testWidth);
      for (let i = 0; i < rendered.length; i++) {
        const vw = visibleWidth(rendered[i]);
        expect(vw).toBeLessThanOrEqual(testWidth);
      }
    }
  });
});
