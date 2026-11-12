import { describe, expect, test, beforeEach } from "bun:test";
import {
  DOUBLE_ESC_THRESHOLD_MS,
  getLastUserPrompt,
  handleEscapeKey,
  installPromptRecall,
  resetInterruptState,
  setLastUserPrompt,
  type EditorLike,
} from "../src/interrupt-handler";

beforeEach(() => {
  resetInterruptState();
});

describe("interrupt-handler: prompt tracking", () => {
  test("records the last submitted prompt", () => {
    setLastUserPrompt("implement authentication with oauth");
    expect(getLastUserPrompt()).toBe("implement authentication with oauth");
  });

  test("ignores empty or whitespace-only prompts", () => {
    setLastUserPrompt("first valid prompt");
    setLastUserPrompt("   ");
    expect(getLastUserPrompt()).toBe("first valid prompt");
  });
});

describe("interrupt-handler: esc timing", () => {
  test("a single Escape does not recall", () => {
    setLastUserPrompt("test prompt");
    expect(handleEscapeKey(1000)).toBeUndefined();
  });

  test("two Escapes within the threshold recall the prompt", () => {
    setLastUserPrompt("implement jwt validation");
    expect(handleEscapeKey(1000)).toBeUndefined();
    expect(handleEscapeKey(1000 + DOUBLE_ESC_THRESHOLD_MS)).toBe("implement jwt validation");
  });

  test("Escapes beyond the threshold do not recall", () => {
    setLastUserPrompt("implement jwt validation");
    handleEscapeKey(1000);
    expect(handleEscapeKey(2000)).toBeUndefined();
  });

  test("the same instant reported twice is not a double-tap", () => {
    setLastUserPrompt("p");
    handleEscapeKey(1000);
    // delta === 0 means one press seen twice, not two presses.
    expect(handleEscapeKey(1000)).toBeUndefined();
  });

  test("no recorded prompt means no recall even on a double-tap", () => {
    handleEscapeKey(1000);
    expect(handleEscapeKey(1100)).toBeUndefined();
  });
});

describe("interrupt-handler: editor wiring", () => {
  /** A minimal editor that records setText calls. */
  function fakeEditor(text = "") {
    const calls: string[] = [];
    let current = text;
    const editor: EditorLike = {
      getText: () => current,
      setText: (t) => {
        current = t;
        calls.push(t);
      },
    };
    return { editor, calls, set: (t: string) => (current = t) };
  }

  test("double-Esc actually puts the prompt back in the editor", () => {
    setLastUserPrompt("restore me");
    const { editor, calls } = fakeEditor();
    let clock = 1000;
    installPromptRecall(editor, { now: () => clock });

    editor.onEscape!(); // first press
    expect(calls).toEqual([]);
    clock += 200; // within threshold
    editor.onEscape!();
    expect(calls).toEqual(["restore me"]);
  });

  test("Escape while mid-edit never restores, so an abandoned edit is not lost", () => {
    setLastUserPrompt("old prompt");
    const { editor, calls } = fakeEditor("half-typed text");
    let clock = 1000;
    installPromptRecall(editor, { now: () => clock });

    editor.onEscape!();
    clock += 100;
    editor.onEscape!();
    expect(calls).toEqual([]);
  });

  test("pi's own onEscape still runs, preserving interrupt and tree behaviour", () => {
    let piHandlerRan = 0;
    const { editor } = fakeEditor();
    editor.onEscape = () => {
      piHandlerRan++;
    };
    installPromptRecall(editor, { now: () => 1000 });

    editor.onEscape!();
    expect(piHandlerRan).toBe(1);
  });

  test("recall fires once, not on a third chained Escape", () => {
    setLastUserPrompt("once");
    const { editor, calls } = fakeEditor();
    let clock = 1000;
    installPromptRecall(editor, { now: () => clock });

    editor.onEscape!();
    clock += 100;
    editor.onEscape!(); // recalls, and clears its own window
    // The editor now holds text, so further Escapes are mid-edit and do nothing.
    clock += 100;
    editor.onEscape!();
    expect(calls).toEqual(["once"]);
  });

  test("onRecall receives the restored text", () => {
    setLastUserPrompt("notify me");
    const { editor } = fakeEditor();
    const seen: string[] = [];
    let clock = 1000;
    installPromptRecall(editor, { now: () => clock, onRecall: (p) => seen.push(p) });

    editor.onEscape!();
    clock += 100;
    editor.onEscape!();
    expect(seen).toEqual(["notify me"]);
  });

  test("works when the editor exposes no getText (treated as empty)", () => {
    setLastUserPrompt("x");
    const calls: string[] = [];
    const editor: EditorLike = { setText: (t) => calls.push(t) };
    let clock = 1000;
    installPromptRecall(editor, { now: () => clock });

    editor.onEscape!();
    clock += 100;
    editor.onEscape!();
    expect(calls).toEqual(["x"]);
  });
});
