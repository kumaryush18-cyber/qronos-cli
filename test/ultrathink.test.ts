import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  ULTRATHINK_NOTICE,
  ULTRATHINK_SECTION,
  findUltrathink,
  hasUltrathink,
  maskCode,
  paintUltrathinkLine,
  paintUltrathinkLines,
  ultrathinkSection,
} from "../src/ultrathink";

const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

describe("findUltrathink", () => {
  test("finds the plain word", () => {
    expect(findUltrathink("ultrathink this bug")).toEqual([{ start: 0, end: 10 }]);
  });

  test("finds it with punctuation around", () => {
    expect(findUltrathink("please, ultrathink: now.").length).toBe(1);
  });

  test("is case sensitive", () => {
    expect(findUltrathink("Ultrathink this")).toEqual([]);
    expect(findUltrathink("ULTRAHINK")).toEqual([]);
  });

  test("ignores a longer word", () => {
    expect(findUltrathink("ultrathinking about it")).toEqual([]);
    expect(findUltrathink("ultrathinks")).toEqual([]);
  });

  test("ignores a path or a file name", () => {
    expect(findUltrathink("open ultrathink.ts")).toEqual([]);
    expect(findUltrathink("src/ultrathink")).toEqual([]);
    expect(findUltrathink("ultrathink-file")).toEqual([]);
  });

  test("ignores an inline code span", () => {
    expect(findUltrathink("run `ultrathink` later")).toEqual([]);
  });

  test("ignores a fenced code block", () => {
    expect(findUltrathink("```\nultrathink\n```")).toEqual([]);
  });

  test("still finds a word after a code span", () => {
    expect(findUltrathink("`x` then ultrathink now").length).toBe(1);
  });

  test("finds several occurrences", () => {
    expect(findUltrathink("ultrathink then ultrathink").length).toBe(2);
  });

  test("handles an empty string", () => {
    expect(findUltrathink("")).toEqual([]);
  });
});

describe("maskCode", () => {
  test("keeps the length so indexes stay valid", () => {
    const text = "before `code` after";
    expect(maskCode(text)).toHaveLength(text.length);
  });

  test("blanks a fence", () => {
    expect(maskCode("```js\nx\n```").trim()).toBe("");
  });
});

describe("hasUltrathink", () => {
  test("is true for the word", () => {
    expect(hasUltrathink("ultrathink")).toBe(true);
  });

  test("is false for nothing", () => {
    expect(hasUltrathink("")).toBe(false);
    expect(hasUltrathink("think harder")).toBe(false);
  });
});

describe("painting", () => {
  test("colours the word without changing the visible width", () => {
    const line = "╭──────────────────╮ ultrathink";
    const painted = paintUltrathinkLine(line, 0);
    expect(visibleWidth(painted)).toBe(visibleWidth(line));
  });

  test("leaves the text readable when the colour codes are removed", () => {
    const painted = paintUltrathinkLine("please ultrathink now", 0);
    expect(stripAnsi(painted)).toBe("please ultrathink now");
  });

  test("adds colour codes", () => {
    expect(paintUltrathinkLine("ultrathink", 0)).toContain("\x1b[");
  });

  test("changes with time, so the band moves", () => {
    const a = paintUltrathinkLine("ultrathink", 0);
    const b = paintUltrathinkLine("ultrathink", 750);
    expect(a).not.toBe(b);
  });

  test("does nothing when the word is absent", () => {
    const line = "just a normal prompt";
    expect(paintUltrathinkLine(line, 0)).toBe(line);
  });

  test("paints two occurrences independently", () => {
    const painted = paintUltrathinkLine("ultrathink and ultrathink", 0);
    expect(stripAnsi(painted)).toBe("ultrathink and ultrathink");
    expect(painted.split("\x1b[").length).toBeGreaterThan(20);
  });

  test("does not paint a file name", () => {
    const line = "open src/ultrathink.ts";
    expect(paintUltrathinkLine(line, 0)).toBe(line);
  });

  test("does not paint inside a code span", () => {
    const line = "run `ultrathink` now";
    expect(paintUltrathinkLine(line, 0)).toBe(line);
  });

  test("maps over lines", () => {
    const out = paintUltrathinkLines(["a", "ultrathink"], 0);
    expect(out[0]).toBe("a");
    expect(out[1]).toContain("\x1b[");
  });
});

describe("the notice", () => {
  test("asks for a plan and for honest reporting", () => {
    expect(ULTRATHINK_NOTICE).toContain("state the plan");
    expect(ULTRATHINK_NOTICE).toContain("what you checked and what you did not check");
  });

  test("says it applies to one turn only", () => {
    expect(ULTRATHINK_NOTICE).toContain("this turn only");
  });

  test("the section has a heading", () => {
    expect(ultrathinkSection()).toBe(`## Ultrathink (this turn)\n${ULTRATHINK_NOTICE}`);
  });

  test("the section key is namespaced", () => {
    expect(ULTRATHINK_SECTION).toBe("qronos-ultrathink");
  });
});
