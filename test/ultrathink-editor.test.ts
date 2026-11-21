import { describe, expect, test } from "bun:test";
import { ULTRATHINK_FRAME_MS, UltrathinkEditor } from "../src/ultrathink-editor";
import { createUltrathinkExtension, ultrathinkConfigFromEnv } from "../src/ultrathink-extension";
import { ULTRATHINK_SECTION } from "../src/ultrathink";

/* A fake of the parts of TUI and theme the real Editor touches while rendering. */
const fakeTheme = { borderColor: (text: string) => text, selectList: {} };

function makeTui() {
  const state = { renders: 0 };
  return {
    state,
    tui: { requestRender: () => (state.renders += 1), terminal: { rows: 40, columns: 80 } } as never,
  };
}

function makeEditor(text: string, overrides: { startTicker?: unknown; stopTicker?: unknown; now?: () => number } = {}) {
  const { tui, state } = makeTui();
  const editor = new UltrathinkEditor(tui, fakeTheme as never, {} as never, {
    now: overrides.now ?? (() => 0),
    startTicker: (overrides.startTicker as never) ?? ((tick: () => void) => ({ tick })),
    stopTicker: (overrides.stopTicker as never) ?? (() => {}),
  });
  // The base editor keeps its text privately; render() reads it through getText().
  (editor as unknown as { setText(text: string): void }).setText(text);
  return { editor, state, width: 60 };
}

describe("UltrathinkEditor", () => {
  test("paints the word in the rendered lines", () => {
    const { editor, width } = makeEditor("ultrathink please");
    const lines = editor.render(width);
    expect(lines.join("\n")).toContain("\x1b[");
    expect(lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")).toContain("ultrathink please");
  });

  test("does not paint ordinary text", () => {
    const { editor, width } = makeEditor("plain prompt");
    const lines = editor.render(width).join("\n");
    expect(lines).not.toContain("\x1b[38;");
  });

  test("starts the animation when the word appears", () => {
    let started = 0;
    const { editor, width } = makeEditor("ultrathink", { startTicker: () => (started += 1) });
    editor.render(width);
    expect(started).toBe(1);
    expect(editor.animating).toBe(true);
  });

  test("does not start twice", () => {
    let started = 0;
    const { editor, width } = makeEditor("ultrathink", { startTicker: () => (started += 1) });
    editor.render(width);
    editor.render(width);
    expect(started).toBe(1);
  });

  test("stops when the word is deleted", () => {
    let stopped = 0;
    const { editor, width } = makeEditor("ultrathink", { stopTicker: () => (stopped += 1) });
    editor.render(width);
    (editor as unknown as { setText(text: string): void }).setText("plain");
    editor.render(width);
    expect(stopped).toBe(1);
    expect(editor.animating).toBe(false);
  });

  test("the ticker asks the terminal to redraw", () => {
    let tick: (() => void) | undefined;
    const { editor, width, state } = makeEditor("ultrathink", {
      startTicker: (fn: () => void) => {
        tick = fn;
        return {};
      },
    });
    editor.render(width);
    tick!();
    expect(state.renders).toBe(1);
  });

  test("the ticker stops itself when the text changed without a render", () => {
    let tick: (() => void) | undefined;
    let stopped = 0;
    const { editor, width } = makeEditor("ultrathink", {
      startTicker: (fn: () => void) => {
        tick = fn;
        return {};
      },
      stopTicker: () => (stopped += 1),
    });
    editor.render(width);
    (editor as unknown as { setText(text: string): void }).setText("gone");
    tick!();
    expect(stopped).toBe(1);
    expect(editor.animating).toBe(false);
  });

  test("dispose stops the animation", () => {
    let stopped = 0;
    const { editor, width } = makeEditor("ultrathink", { stopTicker: () => (stopped += 1) });
    editor.render(width);
    editor.dispose();
    expect(stopped).toBe(1);
  });

  test("the frame rate is the documented one", () => {
    expect(ULTRATHINK_FRAME_MS).toBe(90);
  });
});

describe("the extension", () => {
  function harness(config?: ReturnType<typeof ultrathinkConfigFromEnv>) {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
    const api = { on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => handlers.set(name, handler) };
    const extension = createUltrathinkExtension({ config });
    (extension as unknown as { factory: (api: unknown) => void }).factory(api);
    return handlers;
  }

  function ctx() {
    const calls = { editors: 0, statuses: [] as Array<{ key: string; text?: string }> };
    return {
      calls,
      value: {
        ui: {
          setEditorComponent: () => (calls.editors += 1),
          setStatus: (key: string, text?: string) => calls.statuses.push({ key, text }),
        },
      } as never,
    };
  }

  test("registers under the documented name", () => {
    expect(createUltrathinkExtension({}).name).toBe("qronos-ultrathink");
  });

  test("installs the editor on session start", async () => {
    const { calls, value } = ctx();
    await harness().get("session_start")!({}, value);
    expect(calls.editors).toBe(1);
  });

  test("adds the hidden section only for a prompt with the word", async () => {
    const sections: Record<string, string> = {};
    const event = { prompt: "ultrathink fix this", systemPromptOptions: { sections } };
    await harness().get("before_agent_start")!(event, ctx().value);
    expect(sections[ULTRATHINK_SECTION]).toContain("state the plan");
  });

  test("does not add the section for a normal prompt", async () => {
    const sections: Record<string, string> = {};
    await harness().get("before_agent_start")!({ prompt: "fix this", systemPromptOptions: { sections } }, ctx().value);
    expect(sections[ULTRATHINK_SECTION]).toBeUndefined();
  });

  test("does not add the section for the word inside code", async () => {
    const sections: Record<string, string> = {};
    await harness().get("before_agent_start")!(
      { prompt: "run `ultrathink` later", systemPromptOptions: { sections } },
      ctx().value,
    );
    expect(sections[ULTRATHINK_SECTION]).toBeUndefined();
  });

  test("shows a status label when active", async () => {
    const { calls, value } = ctx();
    await harness().get("before_agent_start")!({ prompt: "ultrathink it", systemPromptOptions: { sections: {} } }, value);
    expect(calls.statuses.at(-1)?.text).toBe("ultrathink on");
  });

  test("a disabled extension does nothing at all", async () => {
    const config = ultrathinkConfigFromEnv({ QRONOS_ULTRATHINK: "0" });
    const { calls, value } = ctx();
    const sections: Record<string, string> = {};
    await harness(config).get("session_start")!({}, value);
    await harness(config).get("before_agent_start")!({ prompt: "ultrathink x", systemPromptOptions: { sections } }, value);
    expect(calls.editors).toBe(0);
    expect(calls.statuses).toEqual([]);
    expect(sections[ULTRATHINK_SECTION]).toBeUndefined();
  });

  test("an editor failure does not break the session", async () => {
    const value = {
      ui: {
        setEditorComponent: () => {
          throw new Error("no terminal");
        },
        setStatus: () => {},
      },
    } as never;
    await expect(harness().get("session_start")!({}, value)).resolves.toBeUndefined();
  });
});

describe("config", () => {
  test("is on by default", () => {
    expect(ultrathinkConfigFromEnv({}).enabled).toBe(true);
  });

  test("QRONOS_ULTRATHINK=0 turns it off", () => {
    expect(ultrathinkConfigFromEnv({ QRONOS_ULTRATHINK: "0" }).enabled).toBe(false);
    expect(ultrathinkConfigFromEnv({ QRONOS_ULTRATHINK: "false" }).enabled).toBe(false);
  });
});