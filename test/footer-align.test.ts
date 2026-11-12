import { beforeEach, describe, expect, test } from "bun:test";
import { installFooterRightAlign } from "../src/footer-align";
import { getExecutionModeStatusLine, initExecutionMode, setExecutionModePersistence } from "../src/execution-modes";

const mk = (lines: string[]) => ({ footer: { render: (_w: number) => lines } });

/** The mode line is prepended, so pi's footer starts at index 1. */
const withoutMode = (out: string[]) => out.slice(1);

beforeEach(() => {
  setExecutionModePersistence(undefined);
  initExecutionMode(false, "auto");
});

describe("installFooterRightAlign", () => {
  test("prepends the mode line and right-aligns only pi's status line", () => {
    const m = mk(["pwd", "stats", "14,613 + 100,000 credits"]);
    installFooterRightAlign(m);
    const out = m.footer.render(40);
    expect(out[0]).toBe(getExecutionModeStatusLine(40));
    const piLines = withoutMode(out);
    expect(piLines.slice(0, 2)).toEqual(["pwd", "stats"]);
    expect(piLines[2]).toBe(" ".repeat(40 - 24) + "14,613 + 100,000 credits");
  });

  test("ignores ANSI codes when measuring and never exceeds width", () => {
    const m = mk(["a", "b", "\x1b[2mhi\x1b[0m"]);
    installFooterRightAlign(m);
    expect(withoutMode(m.footer.render(10))[2]).toBe(" ".repeat(8) + "\x1b[2mhi\x1b[0m");
    const n = mk(["a", "b", "x".repeat(30)]);
    installFooterRightAlign(n);
    expect(withoutMode(n.footer.render(10))[2]).toBe("x".repeat(30));
  });

  test("slow-lane middle dot is still aligned", () => {
    const m = mk(["a", "b", "0 credits · slow lane"]);
    installFooterRightAlign(m);
    expect(withoutMode(m.footer.render(30))[2]).toBe(" ".repeat(9) + "0 credits · slow lane");
  });

  test("wide glyphs or non-SGR escapes are left as pi drew them (no over-width line)", () => {
    for (const last of ["100 credits 🚀 ready", "100 credits 中文", "\x1b]8;;https://x\x07docs\x1b]8;;\x07"]) {
      const m = mk(["a", "b", last]);
      installFooterRightAlign(m);
      expect(withoutMode(m.footer.render(40))[2]).toBe(last);
    }
  });

  test("still aligns pi's only line when pi draws two footer lines", () => {
    // Regression: the old `length <= 2` guard skipped alignment entirely once
    // the mode line pushed the total to three.
    const m = mk(["a", "b"]);
    installFooterRightAlign(m);
    const out = m.footer.render(40);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(getExecutionModeStatusLine(40));
    expect(withoutMode(out)).toEqual(["a", " ".repeat(39) + "b"]);
  });

  test("shows the mode line even when pi renders no footer lines", () => {
    const m = mk([]);
    installFooterRightAlign(m);
    expect(m.footer.render(40)).toEqual([getExecutionModeStatusLine(40)]);
  });
});
