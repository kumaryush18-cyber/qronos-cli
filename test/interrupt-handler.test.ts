import { describe, expect, test, beforeEach } from "bun:test";
import {
  HISTORY_LIMIT,
  historySize,
  lastPrompt,
  promptAt,
  recallInto,
  recordPrompt,
  resetHistory,
  type EditorLike,
} from "../src/interrupt-handler";

beforeEach(() => {
  resetHistory();
});

describe("prompt history: recording", () => {
  test("records submitted prompts in order", () => {
    recordPrompt("first");
    recordPrompt("second");
    expect(lastPrompt()).toBe("second");
    expect(promptAt(1)).toBe("first");
  });

  test("ignores empty and whitespace-only prompts", () => {
    recordPrompt("real");
    recordPrompt("   ");
    expect(historySize()).toBe(1);
  });

  test("collapses consecutive duplicates", () => {
    recordPrompt("same");
    recordPrompt("same");
    expect(historySize()).toBe(1);
  });

  test("is bounded to HISTORY_LIMIT, dropping the oldest", () => {
    for (let i = 0; i < HISTORY_LIMIT + 10; i++) recordPrompt(`p${i}`);
    expect(historySize()).toBe(HISTORY_LIMIT);
    expect(lastPrompt()).toBe(`p${HISTORY_LIMIT + 9}`);
  });

  test("trims surrounding whitespace", () => {
    recordPrompt("  padded  ");
    expect(lastPrompt()).toBe("padded");
  });
});

describe("prompt history: lookup", () => {
  test("out-of-range indices return undefined instead of wrapping", () => {
    recordPrompt("only");
    expect(promptAt(5)).toBeUndefined();
    expect(promptAt(-1)).toBeUndefined();
  });

  test("an empty history has no last prompt", () => {
    expect(lastPrompt()).toBeUndefined();
  });

  test("non-integer indices are rejected", () => {
    recordPrompt("x");
    expect(promptAt(0.5)).toBeUndefined();
  });
});

describe("prompt history: recall", () => {
  function editor(text = "") {
    const sets: string[] = [];
    let current = text;
    const e: EditorLike = {
      getText: () => current,
      setText: (t) => {
        current = t;
        sets.push(t);
      },
    };
    return { e, sets };
  }

  test("restores the last prompt into an empty editor", () => {
    recordPrompt("bring me back");
    const { e, sets } = editor();
    expect(recallInto(e, 0)).toEqual({ restored: "bring me back" });
    expect(sets).toEqual(["bring me back"]);
  });

  test("restores the Nth previous prompt", () => {
    recordPrompt("old");
    recordPrompt("newer");
    const { e } = editor();
    expect(recallInto(e, 1).restored).toBe("old");
  });

  test("refuses to overwrite text the user is typing", () => {
    recordPrompt("previous");
    const { e, sets } = editor("half-written message");
    expect(recallInto(e, 0).reason).toBe("editor-busy");
    expect(sets).toEqual([]);
  });

  test("force overrides the busy guard", () => {
    recordPrompt("previous");
    const { e, sets } = editor("draft");
    expect(recallInto(e, 0, { force: true }).restored).toBe("previous");
    expect(sets).toEqual(["previous"]);
  });

  test("reports empty history and missing editor distinctly", () => {
    expect(recallInto(editor().e, 0).reason).toBe("empty-history");
    recordPrompt("x");
    expect(recallInto(undefined, 0).reason).toBe("no-editor");
    expect(recallInto(editor().e, 3).reason).toBe("out-of-range");
  });
});

describe("prompt history: Escape is not involved", () => {
  // Regression: an earlier version wrapped editor.onEscape so a double press
  // restored the prompt. Escape must stay purely interrupt.
  test("no recall happens without an explicit call", () => {
    recordPrompt("do not auto-restore");
    const sets: string[] = [];
    const e: EditorLike = { getText: () => "", setText: (t) => sets.push(t) };
    // Merely having history must never populate the editor.
    expect(sets).toEqual([]);
    expect(historySize()).toBe(1);
    void e;
  });

  test("the module exposes no escape handler at all", () => {
    const mod = require("../src/interrupt-handler") as Record<string, unknown>;
    expect(mod.handleEscapeKey).toBeUndefined();
    expect(mod.installPromptRecall).toBeUndefined();
  });
});
