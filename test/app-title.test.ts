import { describe, expect, test } from "bun:test";
import { APP_TITLE_TEXT, terminalTitleSequence } from "../src/app-title";

describe("terminal title escape", () => {
  test("sets both the icon/title (OSC 0) and the window title (OSC 2)", () => {
    const seq = terminalTitleSequence(APP_TITLE_TEXT);
    expect(seq).toBe("\x1b]0;Qronos CLI\x07\x1b]2;Qronos CLI\x07");
  });

  test("a custom title is used as given", () => {
    expect(terminalTitleSequence("My App")).toContain("]0;My App\x07");
  });

  test("control characters cannot inject another escape", () => {
    const seq = terminalTitleSequence("evil\x1b]0;pwned\x07title");
    // only the two sequences we add ourselves survive
    expect(seq.match(/\x1b/g)?.length).toBe(2);
    expect(seq).toContain("evil]0;pwnedtitle");
  });
});
