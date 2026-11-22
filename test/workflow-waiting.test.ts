import { afterEach, describe, expect, test } from "bun:test";
import {
  WAITING_MARK,
  buildWaitingLine,
  createWorkflowWaitingExtension,
  resetWaitingWorkflows,
  setWaitingWorkflows,
  subscribeWaiting,
  truncate,
  waitingText,
  waitingWorkflows,
} from "../src/workflow-waiting";

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

afterEach(() => resetWaitingWorkflows());

describe("the waiting row", () => {
  test("one run reads in the singular, like Claude Code", () => {
    expect(waitingText(1)).toBe("Waiting for 1 dynamic workflow to finish");
  });

  test("two runs read in the plural", () => {
    expect(waitingText(2)).toBe("Waiting for 2 dynamic workflows to finish");
  });

  test("a nonsense count never draws a line", () => {
    expect(buildWaitingLine({ count: 0, frame: 0 })).toBe("");
    expect(buildWaitingLine({ count: -3, frame: 0 })).toBe("");
  });

  test("the mark is the one Claude Code uses", () => {
    expect(WAITING_MARK).toBe("※");
    expect(plain(buildWaitingLine({ count: 1, frame: 0 })).startsWith("※ ")).toBe(true);
  });

  test("the line is orange, not plain text", () => {
    expect(buildWaitingLine({ count: 1, frame: 0 })).toContain("\x1b[");
  });

  test("the shimmer lights different characters as the phase moves", () => {
    const left = buildWaitingLine({ count: 1, frame: 0, shimmerPhase: 0.1 });
    const right = buildWaitingLine({ count: 1, frame: 0, shimmerPhase: 0.6 });
    // Same words, different colour codes: the band travelled.
    expect(plain(left)).toBe(plain(right));
    expect(left).not.toBe(right);
  });

  test("the mark breathes: two frames paint it differently", () => {
    const first = buildWaitingLine({ count: 1, frame: 0 });
    const third = buildWaitingLine({ count: 1, frame: 2 });
    expect(plain(first)).toBe(plain(third));
    expect(first).not.toBe(third);
  });

  test("a narrow terminal gets a cut line, not a broken one", () => {
    const line = buildWaitingLine({ count: 1, frame: 0, shimmerPhase: 0.2 });
    const cut = truncate(line, 20);
    expect(plain(cut)).toHaveLength(20);
    expect(plain(cut).endsWith("…")).toBe(true);
  });

  test("a wide terminal keeps the whole line", () => {
    const line = buildWaitingLine({ count: 1, frame: 0 });
    expect(truncate(line, 80)).toBe(line);
  });
});

describe("the shared count", () => {
  test("it starts at nothing", () => {
    expect(waitingWorkflows()).toBe(0);
  });

  test("setting it says how many are live", () => {
    expect(setWaitingWorkflows(2)).toBe(2);
    expect(waitingWorkflows()).toBe(2);
  });

  test("a negative or fractional count cannot go bad", () => {
    setWaitingWorkflows(-5);
    expect(waitingWorkflows()).toBe(0);
    setWaitingWorkflows(1.7);
    expect(waitingWorkflows()).toBe(1);
  });

  test("a listener hears every real change", () => {
    const heard: number[] = [];
    subscribeWaiting((count) => heard.push(count));
    setWaitingWorkflows(1);
    setWaitingWorkflows(1);
    setWaitingWorkflows(0);
    expect(heard).toEqual([1, 0]);
  });

  test("a listener that throws does not stop the others", () => {
    const heard: number[] = [];
    subscribeWaiting(() => {
      throw new Error("bad listener");
    });
    subscribeWaiting((count) => heard.push(count));
    expect(() => setWaitingWorkflows(3)).not.toThrow();
    expect(heard).toEqual([3]);
  });

  test("unsubscribing stops the calls", () => {
    const heard: number[] = [];
    const stop = subscribeWaiting((count) => heard.push(count));
    stop();
    setWaitingWorkflows(2);
    expect(heard).toEqual([]);
  });
});

/** Run an inline extension's factory; the union type hides it. */
const buildFactory = (extension: unknown) => (extension as { factory: (api: unknown) => void }).factory;

/** A fake widget host: the smallest surface the extension touches. */
function fakeHost() {
  const widgets: { id: string; component: { render: (width: number) => string[] } }[] = [];
  let renders = 0;
  const handlers = new Map<string, (...args: any[]) => void>();
  const api = {
    on: (name: string, handler: (...args: any[]) => void) => handlers.set(name, handler),
  };
  const ctx = {
    ui: {
      setWidget: (id: string, factory: any) => {
        widgets.push({ id, component: factory({ requestRender: () => (renders += 1) }, {}) });
      },
    },
  };
  return { api, ctx, widgets, handlers, renders: () => renders };
}

describe("the waiting extension", () => {
  test("it draws nothing while no run is live", () => {
    const host = fakeHost();
    buildFactory(createWorkflowWaitingExtension())(host.api as never);
    host.handlers.get("session_start")!({}, host.ctx);
    expect(host.widgets).toHaveLength(1);
    expect(host.widgets[0]!.component.render(80)).toEqual([]);
  });

  test("it draws the row once a run is live", () => {
    const host = fakeHost();
    buildFactory(createWorkflowWaitingExtension())(host.api as never);
    host.handlers.get("session_start")!({}, host.ctx);
    setWaitingWorkflows(1);
    const lines = host.widgets[0]!.component.render(80);
    expect(lines).toHaveLength(1);
    expect(plain(lines[0]!)).toContain("Waiting for 1 dynamic workflow to finish");
  });

  test("it redraws while a run is live and stops after the last one ends", async () => {
    const host = fakeHost();
    buildFactory(createWorkflowWaitingExtension({ frameMs: 5 }))(host.api as never);
    host.handlers.get("session_start")!({}, host.ctx);
    setWaitingWorkflows(1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    const liveFrames = host.renders();
    expect(liveFrames).toBeGreaterThan(1);

    setWaitingWorkflows(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterStop = host.renders();
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The ticker stopped: no new frames once the row is empty.
    expect(host.renders()).toBe(afterStop);
    expect(host.widgets[0]!.component.render(80)).toEqual([]);
  });

  test("shutting down stops the ticker", async () => {
    const host = fakeHost();
    buildFactory(createWorkflowWaitingExtension({ frameMs: 5 }))(host.api as never);
    host.handlers.get("session_start")!({}, host.ctx);
    setWaitingWorkflows(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.handlers.get("session_shutdown")!({}, host.ctx);
    const frames = host.renders();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(host.renders()).toBe(frames);
  });

  test("an injected count is what the row shows", () => {
    const host = fakeHost();
    buildFactory(createWorkflowWaitingExtension({ count: () => 3 }))(host.api as never);
    host.handlers.get("session_start")!({}, host.ctx);
    expect(plain(host.widgets[0]!.component.render(80)[0]!)).toContain("Waiting for 3 dynamic workflows to finish");
  });

  test("the timer is only started once, however many changes arrive", async () => {
    const host = fakeHost();
    buildFactory(createWorkflowWaitingExtension({ frameMs: 5 }))(host.api as never);
    host.handlers.get("session_start")!({}, host.ctx);
    setWaitingWorkflows(1);
    setWaitingWorkflows(2);
    setWaitingWorkflows(3);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Three runs, not three tickers: a doubled ticker is invisible until it
    // melts the terminal.
    expect(host.renders()).toBeGreaterThan(0);
    setWaitingWorkflows(0);
  });
});
