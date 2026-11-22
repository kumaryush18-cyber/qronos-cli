import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkflowJobManager } from "../src/workflow-jobs";
import { WorkflowPanel, PANEL_FRAME_MS, visibleLength } from "../src/workflow-panel";
import { resetSharedSlotPool } from "../src/workflow-slots";
import { workflowConfigFromEnv, type WorkflowAgentRunner } from "../src/workflow-types";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qronos-panel-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  resetSharedSlotPool();
});

const config = (overrides: Partial<ReturnType<typeof workflowConfigFromEnv>> = {}) => ({
  ...workflowConfigFromEnv({}),
  ...overrides,
});

/** A runner that finishes when told to, so a panel sees a live run. */
function gatedRunner() {
  const gates: Array<() => void> = [];
  const runner: WorkflowAgentRunner = async (request) => {
    await new Promise<void>((resolve) => gates.push(resolve));
    return { ok: true, text: `answer: ${request.prompt}`, usage: { input: 10, output: 5, total: 15 } };
  };
  return {
    runner,
    release(count = 1) {
      for (let index = 0; index < count; index += 1) gates.shift()?.();
    },
    get waiting() {
      return gates.length;
    },
  };
}

/** Colour codes the shimmer adds, so a test can read the words. */
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

/** A theme that adds nothing, so the assertions read plain text. */
const plainTheme = { fg: (_slot: string, text: string) => text } as never;

function panelFor(manager: WorkflowJobManager, options: Record<string, unknown> = {}) {
  const renders: number[] = [];
  let closed = 0;
  const panel = new WorkflowPanel({
    manager,
    theme: plainTheme,
    done: () => {
      closed += 1;
    },
    requestRender: () => renders.push(Date.now()),
    frameMs: 5,
    ...options,
  });
  return { panel, renders, closedCount: () => closed };
}

/** Wait until `check` is true, without guessing a sleep length. */
async function until(check: () => boolean, label: string, limit = 200): Promise<void> {
  for (let index = 0; index < limit; index += 1) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe("the workflow panel", () => {
  test("it draws a box with a border and a title", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    manager.launch({ script: "await agent('a'); return 1;", name: "demo" });
    const { panel } = panelFor(manager);
    const lines = panel.render(74);
    expect(lines[0]!.startsWith("╭")).toBe(true);
    expect(lines.at(-1)!.startsWith("╰")).toBe(true);
    // The title glows, so the words only appear once the colour codes are gone.
    expect(plain(lines.join("\n"))).toContain("demo");
    panel.dispose();
    manager.cancel(manager.list()[0]!.id);
  });

  test("with nothing run yet it explains how to start one", () => {
    const manager = new WorkflowJobManager({ runAgent: gatedRunner().runner, config: config(), agentDir: tempDir() });
    const { panel } = panelFor(manager);
    const text = plain(panel.render(74).join("\n"));
    expect(text).toContain("Nothing has run in this session yet.");
    expect(text).toContain("ultracode");
    panel.dispose();
  });

  test("every line is the same visible width, so the box is square", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    manager.launch({ script: "await agent('a very long task name for the panel test'); return 1;" });
    const { panel } = panelFor(manager);
    const lines = panel.render(74);
    for (const line of lines) expect(visibleLength(line)).toBe(visibleLength(lines[0]!));
    panel.dispose();
  });

  test("escape closes it", () => {
    const manager = new WorkflowJobManager({ runAgent: gatedRunner().runner, config: config(), agentDir: tempDir() });
    const { panel, closedCount } = panelFor(manager);
    panel.handleInput("\u001b");
    expect(closedCount()).toBe(1);
    panel.dispose();
  });

  test("space pauses a live run and space again resumes it", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('a'); await agent('b'); return 1;" });
    await until(() => gated.waiting >= 1, "the first agent to start");
    const { panel } = panelFor(manager);
    panel.handleInput(" ");
    expect(manager.get(job.id)?.state).toBe("paused");
    expect(panel.render(74).join("\n")).toContain("paused");
    panel.handleInput(" ");
    expect(manager.get(job.id)?.state).toBe("running");
    panel.dispose();
    manager.cancel(job.id);
  });

  test("x stops the run", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('a'); return 1;" });
    await until(() => gated.waiting >= 1, "the agent to start");
    const { panel } = panelFor(manager);
    panel.handleInput("x");
    await until(() => manager.get(job.id)?.state !== "running", "the run to stop");
    expect(["cancelled", "failed", "done"]).toContain(manager.get(job.id)!.state);
    panel.dispose();
  });

  test("enter opens one agent, escape goes back to the list", async () => {
    // This one finishes at once: the panel opens after the run is over, which is
    // the common case (the report arrives, then you look inside it).
    const quick: WorkflowAgentRunner = async (request) => ({
      ok: true,
      text: `answer: ${request.prompt}`,
      usage: { input: 10, output: 5, total: 15 },
    });
    const manager = new WorkflowJobManager({ runAgent: quick, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('only-one'); return 1;" });
    await until(() => manager.get(job.id)?.done === 1, "the agent to finish");
    const { panel, closedCount } = panelFor(manager);
    panel.handleInput("\r");
    expect(panel.mode).toBe("agent");
    expect(panel.render(74).join("\n")).toContain("only-one");
    panel.handleInput("\u001b");
    expect(panel.mode).toBe("list");
    expect(closedCount()).toBe(0);
    panel.dispose();
  });

  test("the ticker redraws while a run is live and stops when it ends", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    manager.launch({ script: "await agent('a'); return 1;" });
    await until(() => gated.waiting >= 1, "the agent to start");
    const { panel, renders } = panelFor(manager);
    await until(() => renders.length >= 3, "the panel to redraw");
    const before = renders.length;
    expect(before).toBeGreaterThan(2);
    gated.release(1);
    await until(() => manager.active().length === 0, "the run to settle");
    await new Promise((resolve) => setTimeout(resolve, 40));
    const settled = renders.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    // One last frame is fine; a steady stream is not.
    expect(renders.length - settled).toBeLessThan(2);
    panel.dispose();
  });

  test("a panel with nothing live does not start a ticker at all", () => {
    const manager = new WorkflowJobManager({ runAgent: gatedRunner().runner, config: config(), agentDir: tempDir() });
    const { panel, renders } = panelFor(manager);
    expect(renders).toHaveLength(0);
    panel.dispose();
  });

  test("dispose stops the ticker", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('a'); return 1;" });
    await until(() => gated.waiting >= 1, "the agent to start");
    const { panel, renders } = panelFor(manager);
    await until(() => renders.length >= 2, "the panel to redraw");
    panel.dispose();
    const afterDispose = renders.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(renders.length).toBe(afterDispose);
    manager.cancel(job.id);
  });

  test("the frame time is the 120 ms the docs promise", () => {
    expect(PANEL_FRAME_MS).toBe(120);
  });
});