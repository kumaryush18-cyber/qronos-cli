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

  test("r in the detail view asks to run that one agent again", async () => {
    const quick: WorkflowAgentRunner = async (request) => ({
      ok: true,
      text: `answer: ${request.prompt}`,
      usage: { input: 10, output: 5, total: 15 },
    });
    const manager = new WorkflowJobManager({ runAgent: quick, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('only-one'); return 1;" });
    await until(() => manager.get(job.id)?.done === 1, "the agent to finish");
    const asked: string[] = [];
    const { panel } = panelFor(manager, {
      restartAgent: async (jobId: string, agentId: string) => {
        asked.push(`${jobId}:${agentId}`);
        return { ok: true };
      },
    });
    panel.handleInput("\r");
    panel.handleInput("r");
    await until(() => asked.length > 0, "the restart to be asked for");
    expect(asked[0]).toBe(`${job.id}:#0`);
    await until(() => plain(panel.render(74).join("\n")).includes("tokens went up"), "the panel to say it ran");
    panel.dispose();
  });

  test("the panel says when the task was edited, not just that it ran", async () => {
    const quick: WorkflowAgentRunner = async (request) => ({ ok: true, text: `answer: ${request.prompt}`, usage: { input: 10, output: 5, total: 15 } });
    const manager = new WorkflowJobManager({ runAgent: quick, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('only-one'); return 1;" });
    await until(() => manager.get(job.id)?.done === 1, "the agent to finish");
    const { panel } = panelFor(manager, { restartAgent: async () => ({ ok: true, edited: true }) });
    panel.handleInput("\r");
    panel.handleInput("r");
    await until(() => plain(panel.render(74).join("\n")).includes("tokens went up"), "the panel to say it ran");
    // An edited attempt must not look like a plain repeat: the words changed.
    expect(plain(panel.render(74).join("\n"))).toContain("with the task you edited");
    panel.dispose();
  });

  test("r on a live run says to stop it first, and asks nothing", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config() });
    manager.launch({ script: "await agent('one'); await agent('two'); return 1;" });
    // One agent finished, one still working: the detail view can open, and the
    // run is still live, which is exactly the case that must be refused.
    await until(() => gated.waiting > 0, "the first agent to start");
    gated.release(1);
    const job = manager.list()[0]!;
    await until(() => job.done === 1, "the first agent to finish");
    const asked: string[] = [];
    const { panel } = panelFor(manager, {
      restartAgent: async (jobId: string) => {
        asked.push(jobId);
        return { ok: true };
      },
    });
    panel.handleInput("\r");
    expect(panel.mode).toBe("agent");
    panel.handleInput("r");
    expect(asked).toEqual([]);
    expect(plain(panel.render(74).join("\n"))).toContain("stop the run first");
    panel.dispose();
    manager.cancel(job.id);
  });

  test("tab walks the blocks of the detail view and enter opens the one under the cursor", async () => {
    const quick: WorkflowAgentRunner = async (request) => ({
      ok: true,
      text: "the answer",
      usage: { input: 10, output: 5, total: 15 },
    });
    const manager = new WorkflowJobManager({ runAgent: quick, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('one long task'); return 1;" });
    await until(() => manager.get(job.id)?.done === 1, "the agent to finish");

    const { panel } = panelFor(manager);
    panel.handleInput("\r");
    expect(panel.mode).toBe("agent");
    // Entering the detail starts at the top block, closed.
    expect(panel.selectedBlock).toBe(0);
    expect(panel.expanded).toEqual({});

    panel.handleInput("\t");
    expect(panel.selectedBlock).toBe(1);
    panel.handleInput("\r");
    expect(panel.expanded).toEqual({ activity: true });
    // The same key closes it again, so nothing is one-way.
    panel.handleInput("\r");
    expect(panel.expanded).toEqual({ activity: false });

    panel.handleInput("\t");
    panel.handleInput("\t");
    expect(panel.selectedBlock).toBe(0);
    panel.dispose();
  });

  test("in the detail view the arrows walk the agents of the phase, not the phases", async () => {
    const quick: WorkflowAgentRunner = async (request) => ({
      ok: true,
      text: "the answer",
      usage: { input: 10, output: 5, total: 15 },
    });
    const manager = new WorkflowJobManager({ runAgent: quick, config: config(), agentDir: tempDir() });
    const job = manager.launch({
      script: "await agent('first')\nawait agent('second')\nreturn 1;",
    });
    await until(() => manager.get(job.id)?.done === 2, "both agents to finish");

    const { panel } = panelFor(manager);
    panel.handleInput("\r");
    expect(panel.mode).toBe("agent");
    const before = panel.selectedAgent;
    panel.handleInput("\u001b[B");
    expect(panel.selectedAgent).not.toBe(before);
    // The phase did not move: the detail view owns the arrows now.
    expect(panel.selectedPhase).toBe(0);
    panel.dispose();
  });

  test("the detail view keeps p and x working, because it is the same run", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('one'); return 1;" });
    await until(() => gated.waiting >= 1, "the agent to start");

    const { panel } = panelFor(manager);
    panel.handleInput("\r");
    expect(panel.mode).toBe("agent");
    panel.handleInput("p");
    await until(() => manager.get(job.id)?.state === "paused", "the run to pause");
    panel.handleInput("p");
    await until(() => manager.get(job.id)?.state === "running", "the run to resume");
    panel.handleInput("x");
    await until(() => manager.get(job.id)?.state !== "running", "the run to stop");
    panel.dispose();
  });

  test("the arrows walk the phases, and the right column follows", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    manager.launch({
      script: "phase('First')\nawait agent('one')\nphase('Second')\nawait agent('two')\nreturn 1;",
      name: "two-phases",
    });
    const { panel } = panelFor(manager);
    const shown = () => plain(panel.render(74).join("\n"));
    // The plan appears when the script says `phase(...)`, so wait for the event
    // instead of guessing a sleep length.
    await until(() => shown().includes("▸ 1 First"), "the first phase");
    gated.release(1);
    await until(() => shown().includes("Second"), "the second phase");
    panel.handleInput("\u001b[B");
    const after = shown();
    expect(after).toContain("▸ 2 Second");
    expect(after).toContain("  1 First");
    panel.dispose();
    gated.release(1);
    manager.cancel(manager.list()[0]!.id);
  });

  test("tab moves to the next run when there is more than one", () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const first = manager.launch({ script: "await agent('a'); return 1;", name: "first-run" });
    const second = manager.launch({ script: "await agent('b'); return 2;", name: "second-run" });
    const { panel } = panelFor(manager);
    const shown = () => plain(panel.render(74).join("\n"));
    // The panel opens on the newest run; tab must land on the other one, not on
    // the same view again.
    expect(shown()).toContain(second.name);
    expect(shown()).toContain("job 1/2");
    panel.handleInput("\t");
    expect(shown()).toContain(first.name);
    expect(shown()).toContain("job 2/2");
    panel.handleInput("\t");
    expect(shown()).toContain(second.name);
    panel.dispose();
    manager.cancel(first.id);
    manager.cancel(second.id);
  });

  test("s saves the script and says where it went", () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "return 1;", name: "saved-run" });
    const asked: string[] = [];
    const { panel } = panelFor(manager, {
      saveScript: (id: string) => {
        asked.push(id);
        return "/tmp/somewhere/saved-run.js";
      },
    });
    panel.handleInput("s");
    expect(asked).toEqual([job.id]);
    expect(plain(panel.render(74).join("\n"))).toContain("saved to /tmp/somewhere/saved-run.js");
    panel.dispose();
    manager.cancel(job.id);
  });

  test("s without anything to save does nothing and does not throw", () => {
    const manager = new WorkflowJobManager({ runAgent: gatedRunner().runner, config: config(), agentDir: tempDir() });
    const { panel, closedCount } = panelFor(manager);
    panel.handleInput("s");
    expect(closedCount()).toBe(0);
    panel.dispose();
  });

  test("s says nothing-to-save when the write failed", () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "return 1;", name: "x" });
    const { panel } = panelFor(manager, { saveScript: () => undefined });
    panel.handleInput("s");
    expect(plain(panel.render(74).join("\n"))).toContain("nothing to save yet");
    panel.dispose();
    manager.cancel(job.id);
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

  test("k stops the agent you are looking at, and leaves the run alone", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config(), agentDir: tempDir() });
    const job = manager.launch({
      script: "phase('work'); await agent('first one'); await agent('second one'); return 1;",
    });
    await until(() => gated.waiting > 0, "the first agent to start");
    // Let the first agent finish and the second one start, so there is one finished
    // agent and one live agent: only the live one can be stopped.
    const asked: string[] = [];
    gated.release(1);
    await until(() => gated.waiting > 0 && job.live.size > 0, "the second agent to start");
    const { panel } = panelFor(manager, {
      stopAgent: (jobId: string, agentId: string) => {
        asked.push(`${jobId} ${agentId}`);
        return { ok: true };
      },
    });
    panel.handleInput("\r");
    expect(panel.mode).toBe("agent");
    // The live agent sorts first, so the cursor is already on it.
    panel.handleInput("k");
    const live = [...job.live.keys()][0]!;
    expect(asked).toEqual([`${job.id} ${live}`]);
    expect(plain(panel.render(74).join("\n"))).toContain("the rest of the run keeps going");
    panel.dispose();
    manager.cancel(job.id);
  });

  test("k on an agent that is not running says why, instead of pretending", async () => {
    const quick: WorkflowAgentRunner = async (request) => ({ ok: true, text: `answer: ${request.prompt}`, usage: { input: 1, output: 1, total: 2 } });
    const manager = new WorkflowJobManager({ runAgent: quick, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "await agent('only-one'); return 1;" });
    await until(() => manager.get(job.id)?.done === 1, "the agent to finish");
    const { panel } = panelFor(manager, {
      stopAgent: () => ({ ok: false, error: "that agent is not running any more" }),
    });
    panel.handleInput("\r");
    panel.handleInput("k");
    expect(plain(panel.render(74).join("\n"))).toContain("that agent is not running any more");
    panel.dispose();
  });

  test("a runs the whole phase again, after the tool has asked", async () => {
    const quick: WorkflowAgentRunner = async (request) => ({
      ok: true,
      text: `answer: ${request.prompt}`,
      usage: { input: 10, output: 5, total: 15 },
    });
    const manager = new WorkflowJobManager({ runAgent: quick, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "phase('Look'); await agent('one'); await agent('two'); return 1;" });
    await until(() => manager.get(job.id)?.done === 2, "both agents to finish");
    const asked: string[] = [];
    const { panel } = panelFor(manager, {
      rerunPhase: async (jobId: string, phase: string) => {
        asked.push(`${jobId} ${phase}`);
        return { ok: true, phase, ran: 2, total: 2, skipped: [] };
      },
    });
    panel.handleInput("a");
    await until(() => plain(panel.render(74).join("\n")).includes("tokens went up"), "the notice to appear");
    expect(asked).toEqual([`${job.id} Look`]);
    expect(plain(panel.render(74).join("\n"))).toContain("ran 2 of 2 again");
    panel.dispose();
  });

  test("a on a live run refuses before any card is asked for", async () => {
    const gated = gatedRunner();
    const manager = new WorkflowJobManager({ runAgent: gated.runner, config: config() });
    const job = manager.launch({ script: "phase('Look'); await agent('one'); return 1;" });
    await until(() => gated.waiting > 0, "the agent to start");
    let asked = 0;
    const { panel } = panelFor(manager, {
      rerunPhase: async () => {
        asked += 1;
        return { ok: true, phase: "Look", ran: 1, total: 1, skipped: [] };
      },
    });
    panel.handleInput("a");
    expect(asked).toBe(0);
    expect(plain(panel.render(74).join("\n"))).toContain("stop the run first");
    panel.dispose();
    manager.cancel(job.id);
  });

  test("a reruns the phase and touches no other key's work", async () => {
    // Three keys, three sizes of decision: `x` stops the run, `k` stops one agent,
    // `a` runs a phase again. If one of them answered for another, the bill would
    // pay for something nobody asked for.
    const quick: WorkflowAgentRunner = async (request) => ({
      ok: true,
      text: `answer: ${request.prompt}`,
      usage: { input: 10, output: 5, total: 15 },
    });
    const manager = new WorkflowJobManager({ runAgent: quick, config: config(), agentDir: tempDir() });
    const job = manager.launch({ script: "phase('Look'); await agent('one'); return 1;" });
    await until(() => manager.get(job.id)?.done === 1, "the agent to finish");
    const calls: string[] = [];
    const { panel } = panelFor(manager, {
      rerunPhase: async (jobId: string, phase: string) => {
        calls.push(`phase ${phase}`);
        return { ok: true, phase, ran: 1, total: 1, skipped: [] };
      },
      restartAgent: async (jobId: string, agentId: string) => {
        calls.push(`agent ${agentId}`);
        return { ok: true };
      },
      stopAgent: () => {
        calls.push("stop");
        return { ok: true };
      },
    });
    panel.handleInput("a");
    await until(() => calls.length > 0, "the phase rerun to be asked for");
    expect(calls).toEqual(["phase Look"]);
    panel.dispose();
  });
