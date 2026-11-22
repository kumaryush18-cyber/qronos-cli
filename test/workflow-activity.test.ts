import { describe, expect, test } from "bun:test";
import { WorkflowRuntime } from "../src/workflow-runtime";
import { WorkflowJobManager } from "../src/workflow-jobs";
import { resetSharedSlotPool } from "../src/workflow-slots";
import { AGENT_PROMPT_LIMIT, MAX_ACTIVITY_ROWS, workflowConfigFromEnv, type WorkflowEvent } from "../src/workflow-types";
import { createWorkflowToolExtension } from "../src/workflow-tool";
import type { SubagentRunner } from "../src/agent-tool";

const config = () => ({ ...workflowConfigFromEnv({}), wallClockMs: 5_000, concurrency: 4 });

/** A runner that reports `calls` tool calls, then answers. */
function toolRunner(calls: number, tools = ["Bash", "read", "grep"]) {
  const runner = async (request: { prompt: string; onActivity?: (a: { tool: string; turns: number }) => void }) => {
    for (let index = 0; index < calls; index += 1) {
      request.onActivity?.({ tool: tools[index % tools.length]!, turns: index + 1 });
    }
    return { ok: true, text: "done", usage: { input: 1, output: 1, total: 2 } };
  };
  return runner as never;
}

async function run(script: string, runner: unknown, events: WorkflowEvent[] = []) {
  const runtime = new WorkflowRuntime({
    config: config(),
    runAgent: runner as never,
    onEvent: (event) => events.push(event),
  });
  return runtime.run(script);
}

describe("recording what an agent does", () => {
  test("tool calls become rows on the finished record", async () => {
    const events: WorkflowEvent[] = [];
    const result = await run("return (await agent('look')).text;", toolRunner(3), events);
    const record = result.agents[0]!;
    expect(record.toolCalls).toBe(3);
    expect(record.activity?.map((row) => row.tool)).toEqual(["Bash", "read", "grep"]);
  });

  test("a tool call puts an event on the stream while the agent runs", async () => {
    const events: WorkflowEvent[] = [];
    await run("return (await agent('look')).text;", toolRunner(1), events);
    expect(events.some((event) => event.type === "agent_activity")).toBe(true);
  });

  test("the rows stop at eight, but the count keeps rising", async () => {
    const result = await run("return (await agent('look')).text;", toolRunner(41));
    const record = result.agents[0]!;
    expect(record.activity).toHaveLength(MAX_ACTIVITY_ROWS);
    expect(record.toolCalls).toBe(41);
    // The kept rows are the last ones, which is what "last 3 of 41" means.
    expect(record.activity?.at(-1)?.turns).toBe(41);
  });

  test("every call is reported, so a live count never sticks at a cap", async () => {
    const events: WorkflowEvent[] = [];
    await run("return (await agent('look')).text;", toolRunner(60), events);
    const reported = events.filter((event) => event.type === "agent_activity");
    expect(reported).toHaveLength(60);
    // The last event carries the true total, and the kept rows are still eight.
    expect((reported.at(-1) as { count: number }).count).toBe(60);
  });

  test("the prompt is kept, and it is redacted", async () => {
    const result = await run("return (await agent('read /repo with key sk-live-abcdef1234567890')).text;", toolRunner(0));
    const record = result.agents[0]!;
    expect(record.prompt).toContain("read /repo with key");
    expect(record.prompt).not.toContain("sk-live-abcdef1234567890");
  });

  test("a very long prompt is cut, not kept whole", async () => {
    const long = `x`.repeat(5_000);
    const result = await run(`return (await agent(${JSON.stringify(long)})).text;`, toolRunner(0));
    expect(result.agents[0]!.prompt!.length).toBeLessThanOrEqual(AGENT_PROMPT_LIMIT);
  });

  test("the start event carries the prompt, so a live agent has something to show", async () => {
    const events: WorkflowEvent[] = [];
    await run("return (await agent('map the folders')).text;", toolRunner(0), events);
    const start = events.find((event) => event.type === "agent_start") as { prompt?: string } | undefined;
    expect(start?.prompt).toBe("map the folders");
  });

  test("a runner with no activity hook still works", async () => {
    const result = await run("return (await agent('quiet')).text;", async () => ({ ok: true, text: "fine" }));
    expect(result.ok).toBe(true);
    expect(result.agents[0]!.toolCalls).toBeUndefined();
    expect(result.agents[0]!.activity).toBeUndefined();
  });

  test("a hook that throws cannot break the agent", async () => {
    // The runtime owns the hook it hands to the runner, so an `emit` that throws
    // is the thing to survive: a listener must never be able to fail a run.
    const runtime = new WorkflowRuntime({
      config: config(),
      runAgent: toolRunner(3),
      onEvent: () => {
        throw new Error("listener exploded");
      },
    });
    const result = await runtime.run("return (await agent('look')).text;");
    expect(result.ok).toBe(true);
  });

  test("an empty tool name is ignored", async () => {
    const result = await run("return (await agent('look')).text;", async (request: any) => {
      request.onActivity?.({ tool: "", turns: 1 });
      request.onActivity?.({ tool: "   ", turns: 2 });
      return { ok: true, text: "ok" };
    });
    expect(result.agents[0]!.toolCalls).toBeUndefined();
  });
});

describe("the job keeps the live agents", () => {
  test("an agent is live while it runs and gone when it ends", async () => {
    let release: (() => void) | undefined;
    const runner = async (request: any) => {
      request.onActivity?.({ tool: "Bash", turns: 1 });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, text: "done", usage: { input: 1, output: 1, total: 2 } };
    };
    const manager = new WorkflowJobManager({ runAgent: runner as never, config: config(), startImmediately: true });
    const job = manager.launch({ script: "return (await agent('work')).text;", name: "live-demo" });
    for (let index = 0; index < 100 && job.live.size === 0; index += 1) await new Promise((r) => setTimeout(r, 5));
    expect(job.live.size).toBe(1);
    const live = [...job.live.values()][0]!;
    expect(live.prompt).toBe("work");
    expect(live.toolCalls).toBe(1);
    release?.();
    await job.settled;
    expect(job.live.size).toBe(0);
    expect(job.agents[0]!.toolCalls).toBe(1);
    expect(job.agents[0]!.prompt).toBe("work");
    resetSharedSlotPool();
  });

  test("the live map survives a flood of events, where a window would not", async () => {
    let release: (() => void) | undefined;
    const runner = async (request: any) => {
      for (let index = 0; index < 200; index += 1) request.onActivity?.({ tool: "Bash", turns: index });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ok: true, text: "done" };
    };
    const manager = new WorkflowJobManager({ runAgent: runner as never, config: config(), startImmediately: true });
    const job = manager.launch({ script: "return (await agent('busy')).text;", name: "busy" });
    for (let index = 0; index < 100 && job.live.size === 0; index += 1) await new Promise((r) => setTimeout(r, 5));
    // Two hundred activity events have gone through `recent`, which only keeps 60.
    expect(job.recent.length).toBeLessThanOrEqual(60);
    expect(job.live.size).toBe(1);
    expect([...job.live.values()][0]!.toolCalls).toBe(200);
    release?.();
    await job.settled;
    resetSharedSlotPool();
  });
});

describe("the tool wires the runner's tools into the workflow", () => {
  test("a subagent tool call reaches the panel's data", async () => {
    const runner: SubagentRunner = async (params) => {
      params.onEvent?.({ turns: 1, tool: "Bash" });
      params.onEvent?.({ turns: 2, tool: "read" });
      return { output: "report", turns: 2, toolsUsed: ["Bash", "read"] };
    };
    const tools: Array<Record<string, unknown>> = [];
    const api = {
      registerTool: (tool: Record<string, unknown>) => tools.push(tool),
      registerCommand: () => {},
      registerShortcut: () => {},
      sendMessage: () => {},
      on: () => {},
    } as never;
    (
      createWorkflowToolExtension({ runner, agentDir: "/tmp/qronos-activity-test" }) as unknown as {
        factory: (api: unknown) => void;
      }
    ).factory(api);
    const tool = tools[0] as { execute: Function };
    const result = await tool.execute(
      "1",
      { background: false, script: `const r = await agent("look at src/"); return r.text;` },
      undefined,
      undefined,
      { cwd: "/repo" } as never,
    );
    // The report is what the chat sees; the detail is what the panel reads.
    expect(result.details.ok).toBe(true);
    expect(result.content[0].text).toContain("report");
  });
});
