import { afterEach, describe, expect, test } from "bun:test";
import { WorkflowRuntime } from "../src/workflow-runtime";
import { resetSharedSlotPool } from "../src/workflow-slots";
import { workflowConfigFromEnv, type WorkflowAgentRunner, type WorkflowEvent } from "../src/workflow-types";

afterEach(() => {
  resetSharedSlotPool();
});

const config = (overrides: Partial<ReturnType<typeof workflowConfigFromEnv>> = {}) => ({
  ...workflowConfigFromEnv({}),
  concurrency: 4,
  ...overrides,
});

describe("stopping one agent", () => {
  test("the stopped agent reports stopped, and the other one answers", async () => {
    const started: string[] = [];
    let runtime: WorkflowRuntime | undefined;
    const runner: WorkflowAgentRunner = async (request, signal) => {
      started.push(request.prompt);
      if (request.prompt.includes("block")) {
        // The stop comes from the outside, a moment after the call is in flight.
        setTimeout(() => runtime?.stopAgent("#1"), 5);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 4_000);
          const stop = () => {
            clearTimeout(timer);
            resolve();
          };
          signal?.addEventListener("abort", stop, { once: true });
          if (signal?.aborted) stop();
        });
        return { ok: false, text: "", error: "aborted", usage: { input: 40, output: 10, total: 50 } };
      }
      return { ok: true, text: `answer: ${request.prompt}`, usage: { input: 3, output: 2, total: 5 } };
    };
    const events: WorkflowEvent[] = [];
    runtime = new WorkflowRuntime({ runAgent: runner, config: config(), onEvent: (event) => events.push(event) });

    const result = await runtime.run(`
      const [a, b] = await parallel([
        agent("quick one"),
        agent("block for a while"),
      ]);
      return { a, b };
    `);

    const stopped = result.agents.find((agent) => agent.id === "#1");
    const kept = result.agents.find((agent) => agent.id === "#0");
    expect(kept?.ok).toBe(true);
    expect(stopped?.stopped).toBe(true);
    expect(stopped?.ok).toBe(false);
    expect(stopped?.error).toBe("stopped by you");
    // The run itself did not die: the script still got both answers.
    expect(result.ok).toBe(true);
    const end = events.find((event) => event.type === "agent_end" && event.id === "#1");
    expect(end && end.type === "agent_end" ? end.stopped : false).toBe(true);
    expect(started.length).toBe(2);
  });

  test("the tokens already spent are kept, not thrown away", async () => {
    let runtime: WorkflowRuntime | undefined;
    const runner: WorkflowAgentRunner = async (_request, signal) => {
      setTimeout(() => runtime?.stopAgent("#0"), 5);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 4_000);
        const stop = () => {
          clearTimeout(timer);
          resolve();
        };
        signal?.addEventListener("abort", stop, { once: true });
      });
      return { ok: false, text: "", error: "aborted", usage: { input: 40, output: 10, total: 50 } };
    };
    runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`return await agent("block now");`);
    const only = result.agents[0];
    expect(only?.stopped).toBe(true);
    // The provider reported 50 tokens before the stop; the bill says 50.
    expect(only?.usage?.total).toBe(50);
    expect(result.tokens.total).toBe(50);
  });

  test("stopping an agent that is not running is refused, not pretended", async () => {
    const runtime = new WorkflowRuntime({
      runAgent: async () => ({ ok: true, text: "fine", usage: { input: 1, output: 1, total: 2 } }),
      config: config(),
    });
    await runtime.run(`return await agent("quick");`);
    expect(runtime.stopAgent("#0")).toBe(false);
    expect(runtime.stopAgent("nope")).toBe(false);
  });

  test("stopping the whole run still reaches the agents it owns", async () => {
    let runtime: WorkflowRuntime | undefined;
    let sawAbort = false;
    const runner: WorkflowAgentRunner = async (_request, signal) => {
      setTimeout(() => runtime?.abort(), 5);
      await new Promise<void>((resolve) => {
        const stop = () => {
          sawAbort = true;
          resolve();
        };
        signal?.addEventListener("abort", stop, { once: true });
        setTimeout(resolve, 3_000);
      });
      return { ok: false, text: "", error: "aborted", usage: { input: 1, output: 1, total: 2 } };
    };
    runtime = new WorkflowRuntime({ runAgent: runner, config: config() });
    const result = await runtime.run(`await agent("block one"); return "carried on";`);
    expect(sawAbort).toBe(true);
    // A stop-all is not the same as "stop this agent": the one agent is no longer
    // live, so there is nothing left for a per-agent stop to press.
    expect(runtime.stopAgent("#0")).toBe(false);
    expect(result.agents[0]?.stopped).toBe(false);
  });
});
