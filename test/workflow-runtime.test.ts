import { describe, expect, test } from "bun:test";
import { WorkflowRuntime, cloneResult } from "../src/workflow-runtime";
import {
  DEFAULT_MAX_AGENTS,
  DEFAULT_WALL_CLOCK_MS,
  WorkflowLimitError,
  workflowConfigFromEnv,
  type WorkflowAgentRunner,
} from "../src/workflow-types";

/** A fake agent that records calls and answers with the prompt, unless told otherwise. */
function fakeAgent(handler?: (prompt: string, signal: AbortSignal) => Promise<unknown>) {
  const calls: string[] = [];
  const runner: WorkflowAgentRunner = async (request, signal) => {
    calls.push(request.prompt);
    if (handler) {
      const answer = await handler(request.prompt, signal);
      if (typeof answer === "object" && answer !== null && "ok" in (answer as Record<string, unknown>)) {
        return answer as never;
      }
      return { ok: true, text: String(answer) };
    }
    return { ok: true, text: `answer: ${request.prompt}` };
  };
  return { calls, runner };
}

const config = (overrides: Partial<ReturnType<typeof workflowConfigFromEnv>> = {}) => ({
  ...workflowConfigFromEnv({}),
  ...overrides,
});

describe("config", () => {
  test("the wall clock is ten minutes by default, not two", () => {
    expect(DEFAULT_WALL_CLOCK_MS).toBe(600_000);
  });

  test("a tiny wall clock is refused", () => {
    expect(workflowConfigFromEnv({ QRONOS_WORKFLOW_WALL_CLOCK_MS: "1000" }).wallClockMs).toBe(60_000);
  });

  test("a longer wall clock is accepted", () => {
    expect(workflowConfigFromEnv({ QRONOS_WORKFLOW_WALL_CLOCK_MS: "1800000" }).wallClockMs).toBe(1_800_000);
  });

  test("the agent cap has a sane default", () => {
    expect(DEFAULT_MAX_AGENTS).toBe(60);
  });

  test("concurrency is clamped", () => {
    expect(workflowConfigFromEnv({ QRONOS_WORKFLOW_CONCURRENCY: "0" }).concurrency).toBe(1);
    expect(workflowConfigFromEnv({ QRONOS_WORKFLOW_CONCURRENCY: "999" }).concurrency).toBe(32);
  });
});

describe("a workflow run", () => {
  test("returns the script's value", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run("return 1 + 1;");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(2);
  });

  test("supports top-level await and agent()", async () => {
    const { calls, runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`const a = await agent("do x"); return a.text;`);
    expect(result.value).toBe("answer: do x");
    expect(calls).toEqual(["do x"]);
  });

  test("parses the meta block", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`export const meta = { name: "audit", description: "look" }\nreturn 1;`);
    expect(result.meta).toEqual({ name: "audit", description: "look" });
  });

  test("records phases in order", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`phase("Understand"); phase("Review"); return 1;`);
    expect(result.phases).toEqual(["Understand", "Review"]);
  });

  test("keeps the script's logs", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`log("hello"); console.log("there"); return 1;`);
    expect(result.logs).toEqual(["hello", "there"]);
  });

  test("reports one agent entry per call with its label", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`await agent("a"); await agent("b", { label: "second" }); return 1;`);
    expect(result.agents.map((entry) => entry.label)).toEqual(["a", "second"]);
    expect(result.agents.every((entry) => entry.ok)).toBe(true);
  });

  test("pipeline keeps the input order", async () => {
    const { runner } = fakeAgent(async (prompt) => {
      // Slow down the first item so a naive implementation would reorder.
      await new Promise((resolve) => setTimeout(resolve, prompt === "item-0" ? 15 : 1));
      return { ok: true, text: prompt };
    });
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(
      `const out = await pipeline(["item-0","item-1","item-2"], (item) => agent(item)); return out.map((r) => r.text);`,
    );
    expect(result.value).toEqual(["item-0", "item-1", "item-2"]);
  });

  test("parallel accepts promises and thunks", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(
      `const out = await parallel([agent("one"), () => agent("two")]); return out.map((r) => r.text);`,
    );
    expect(result.value).toEqual(["answer: one", "answer: two"]);
  });

  test("a throwing agent does not abort the other tasks", async () => {
    const { runner } = fakeAgent(async (prompt) => {
      if (prompt === "bad") throw new Error("agent exploded");
      return { ok: true, text: "fine" };
    });
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(
      `const out = await parallel([agent("bad"), agent("good")]); return out.map((r) => r.ok);`,
    );
    expect(result.value).toEqual([false, true]);
  });

  test("a failing agent is reported, not thrown", async () => {
    const { runner } = fakeAgent(async () => ({ ok: false, text: "", error: "no answer from the compiler" }));
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`const r = await agent("x"); return r.error;`);
    expect(result.ok).toBe(true);
    expect(result.value).toBe("no answer from the compiler");
    expect(result.agents[0]!.ok).toBe(false);
  });
});

describe("caps", () => {
  test("stops at the agent budget with a clear message", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config({ maxAgents: 2 }) });
    const result = await runtime.run(`await agent("1"); await agent("2"); await agent("3"); return "done";`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("agent budget exhausted");
    expect(result.agents).toHaveLength(2);
  });

  test("the concurrency limit is respected", async () => {
    let live = 0;
    let peak = 0;
    const { runner } = fakeAgent(async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((resolve) => setTimeout(resolve, 10));
      live -= 1;
      return { ok: true, text: "ok" };
    });
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config({ concurrency: 2 }) });
    const result = await runtime.run(`await pipeline([1,2,3,4,5,6], (n) => agent(String(n))); return 1;`);
    expect(result.ok).toBe(true);
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("log lines are capped and the cut is announced", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config({ maxLogLines: 3 }) });
    const result = await runtime.run(`for (let i = 0; i < 10; i++) log("line " + i); return 1;`);
    expect(result.logs).toHaveLength(4);
    expect(result.logs.at(-1)).toContain("log limit reached");
    expect(result.truncated).toBe(true);
  });

  test("a result that is too large is refused", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config({ maxResultChars: 50 }) });
    const result = await runtime.run(`return "x".repeat(500);`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("too large");
  });

  test("the wall clock stops a run that never finishes", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({
      runAgent: runner,
      config: config({ wallClockMs: 30 }),
      // A script that never settles stands in for a hung fan-out.
      runScript: () => new Promise<never>(() => {}),
    });
    const result = await runtime.run("return 1;");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("wall clock");
  });

  test("an aborted run tells its agents to stop", async () => {
    let seen: AbortSignal | undefined;
    const { runner } = fakeAgent(async (_prompt, signal) => {
      seen = signal;
      return { ok: true, text: "done" };
    });
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    await runtime.run("await agent('x'); return 1;");
    expect(seen?.aborted).toBe(false);
    runtime.abort();
    expect(seen?.aborted).toBe(true);
  });
});

describe("schema", () => {
  test("validated data reaches the script", async () => {
    const { runner } = fakeAgent(async () => ({ ok: true, text: '{"files":["a.ts"]}', data: { files: ["a.ts"] } }));
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(
      `const r = await agent("list", { schema: { type: "object", required: ["files"], properties: { files: { type: "array" } } } }); return r.data.files;`,
    );
    expect(result.value).toEqual(["a.ts"]);
  });

  test("data extracted from text is validated too", async () => {
    const { runner } = fakeAgent(async () => ({ ok: true, text: 'Here it is: {"files":["b.ts"]}' }));
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(
      `const r = await agent("list", { schema: { type: "object", required: ["files"], properties: { files: { type: "array" } } } }); return [r.ok, r.data.files[0]];`,
    );
    expect(result.value).toEqual([true, "b.ts"]);
  });

  test("a schema mismatch marks the agent as failed", async () => {
    const { runner } = fakeAgent(async () => ({ ok: true, text: '{"files":"not an array"}' }));
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(
      `const r = await agent("list", { schema: { type: "object", properties: { files: { type: "array" } } } }); return [r.ok, r.error];`,
    );
    const [ok, error] = result.value as [boolean, string];
    expect(ok).toBe(false);
    expect(String(error)).toContain("schema not satisfied");
  });
});

describe("script safety", () => {
  test("the script cannot reach process", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`return typeof process;`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("process");
  });

  test("the script cannot import", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`import fs from "node:fs"; return 1;`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("cannot import");
  });

  test("the script cannot require", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`const fs = require("fs"); return 1;`);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("require");
  });

  test("eval is refused inside the context", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`return eval("1+1");`);
    expect(result.ok).toBe(false);
  });

  test("the Function constructor is refused inside the context", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`return ({}).constructor.constructor("return process")();`);
    expect(result.ok).toBe(false);
  });

  test("a syntax error is reported as a failed run", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`return (;`);
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  test("an empty script is refused", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run("   ");
    expect(result.ok).toBe(false);
    expect(result.error).toContain("empty");
  });
});

describe("events", () => {
  test("a listener sees start, phase, agents and end in order", async () => {
    const { runner } = fakeAgent();
    const seen: string[] = [];
    const runtime = new WorkflowRuntime({
      runAgent: runner,
      config: config(),
      onEvent: (event) => {
        seen.push(event.type === "phase" ? `phase:${event.name}` : event.type);
      },
    });
    await runtime.run(`phase("Review"); await agent("x"); return 1;`);
    expect(seen).toEqual(["run_start", "phase:Review", "agent_start", "agent_end", "run_end"]);
  });

  test("a listener that throws does not break the run", async () => {
    const { runner } = fakeAgent();
    const runtime = new WorkflowRuntime({
      runAgent: runner,
      config: config(),
      onEvent: () => {
        throw new Error("listener bug");
      },
    });
    const result = await runtime.run(`await agent("x"); return 1;`);
    expect(result.ok).toBe(true);
  });
});

describe("cloneResult", () => {
  test("clones plain data", () => {
    expect(cloneResult({ a: [1, 2] }, 1000)).toEqual({ ok: true, value: { a: [1, 2] } });
  });

  test("drops functions", () => {
    expect(cloneResult({ a: 1, fn: () => 1 }, 1000)).toEqual({ ok: true, value: { a: 1 } });
  });

  test("marks a cycle instead of hanging", () => {
    const value: Record<string, unknown> = { a: 1 };
    value.self = value;
    const cloned = cloneResult(value, 1000);
    expect(cloned.ok).toBe(true);
    if (cloned.ok) expect((cloned.value as Record<string, unknown>).self).toBe("[circular]");
  });

  test("refuses an oversized result", () => {
    const cloned = cloneResult({ text: "x".repeat(500) }, 50);
    expect(cloned.ok).toBe(false);
  });

  test("preserves nested nulls", () => {
    expect(cloneResult({ a: null }, 100)).toEqual({ ok: true, value: { a: null } });
  });
});

describe("limit error", () => {
  test("has a readable name", () => {
    expect(new WorkflowLimitError("nope").name).toBe("WorkflowLimitError");
  });
});
