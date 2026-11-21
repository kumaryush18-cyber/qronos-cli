import { describe, expect, test } from "bun:test";
import {
  BRIGHT_GREEN,
  CROSS,
  DARK_RED,
  PHASE_MARK,
  RUNNING,
  TICK,
  cross,
  formatDuration,
  phaseMark,
  phaseTotals,
  pad,
  tick,
  tokenBar,
} from "../src/workflow-glyphs";

const strip = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("glyphs", () => {
  test("the tick is a tick and the cross is a cross", () => {
    expect(TICK).toBe("✓");
    expect(CROSS).toBe("✗");
  });

  test("a running agent uses the same glyph as the working line", () => {
    expect(RUNNING).toBe("✻");
  });

  test("a phase is marked with an arrow", () => {
    expect(PHASE_MARK).toBe("▸");
  });

  test("the green is a real green and the red is a dark red", () => {
    expect(BRIGHT_GREEN).toBeTruthy();
    expect(DARK_RED).toBeTruthy();
    expect(BRIGHT_GREEN).not.toEqual(DARK_RED);
  });

  test("the tick and cross keep their text after colouring", () => {
    expect(strip(tick())).toBe(TICK);
    expect(strip(cross())).toBe(CROSS);
  });

  test("a phase mark keeps the name visible", () => {
    expect(strip(phaseMark("Review"))).toContain("Review");
  });
});

describe("formatDuration", () => {
  test("seconds for a short run", () => {
    expect(formatDuration(4_200)).toBe("4s");
  });

  test("minutes and padded seconds for a long run", () => {
    expect(formatDuration(125_000)).toBe("2m 05s");
  });

  test("a very short run still says 0s, not 0ms", () => {
    expect(formatDuration(120)).toBe("0s");
  });
});

describe("tokenBar", () => {
  test("no bar for zero", () => {
    expect(tokenBar(0, 100)).toBe("");
  });

  test("a small value still shows one cell", () => {
    expect(tokenBar(1, 10_000).length).toBe(1);
  });

  test("the biggest value fills the width", () => {
    expect(tokenBar(500, 500, 8).length).toBe(8);
  });

  test("a zero maximum cannot divide by zero", () => {
    expect(tokenBar(5, 0)).toBe("");
  });
});

describe("pad", () => {
  test("pads plain text to the width", () => {
    expect(pad("ab", 5)).toBe("ab   ");
  });

  test("colour escapes do not count as width", () => {
    expect(pad("\x1b[31mab\x1b[0m", 4)).toContain("  ");
  });

  test("long text is left alone", () => {
    expect(pad("abcdef", 3)).toBe("abcdef");
  });
});

describe("phaseTotals", () => {
  test("adds agents, tokens and failures", () => {
    expect(
      phaseTotals([
        { name: "a", agents: 2, failed: 0, tokens: 100, durationMs: 10 },
        { name: "b", agents: 3, failed: 1, tokens: 250, durationMs: 20 },
      ]),
    ).toEqual({ agents: 5, tokens: 350, failed: 1 });
  });

  test("an empty list is all zeros", () => {
    expect(phaseTotals([])).toEqual({ agents: 0, tokens: 0, failed: 0 });
  });
});
