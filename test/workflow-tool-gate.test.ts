import { describe, expect, test } from "bun:test";
import { WorkflowRuntime } from "../src/workflow-runtime";
import { workflowConfigFromEnv, type WorkflowToolDecision, type WorkflowToolFacts } from "../src/workflow-types";
import { decideToolUse, readToolFacts } from "../src/workflow-permissions";

const config = workflowConfigFromEnv({ QRONOS_WORKFLOW_CONCURRENCY: "2" });

const shellFacts: WorkflowToolFacts = {
  name: "bash",
  kind: "shell",
  command: "npm test",
  insideProject: true,
  dangerous: false,
  summary: "run: npm test",
};

/** A runner that records what it was asked and answers with a real tool call. */
function runtimeWith(approveTool?: (request: { facts: WorkflowToolFacts; asked: number }) => Promise<WorkflowToolDecision>) {
  const asks: unknown[] = [];
  const runtime = new WorkflowRuntime({
    config,
    approveTool: approveTool
      ? async (request) => {
          asks.push(request);
          return approveTool(request);
        }
      : undefined,
    runAgent: async (request) => {
      // What the wrapper does in the real tool: read the mode, then ask.
      const grants = request.toolGrants?.() ?? new Set<string>();
      const verdict = decideToolUse("manual", shellFacts, grants);
      if (verdict === "ask" && request.approveTool) {
        const decision = await request.approveTool(shellFacts);
        return decision.approved
          ? { ok: true, text: "the tool ran", usage: { input: 1, output: 1, total: 2 } }
          : { ok: false, text: "", error: "not approved" };
      }
      return { ok: true, text: `verdict: ${verdict}`, usage: { input: 1, output: 1, total: 2 } };
    },
  });
  return { runtime, asks };
}

describe("asking before a tool runs", () => {
  test("a refused tool ends the agent with an error, not a crash", async () => {
    const { runtime } = runtimeWith(async () => ({ approved: false }));
    const result = await runtime.run("return await agent('use bash', { label: 'one' });");
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]!.ok).toBe(false);
    expect(result.agents[0]!.error).toContain("not approved");
  });

  test("an approved tool lets the agent finish", async () => {
    const { runtime } = runtimeWith(async () => ({ approved: true }));
    const result = await runtime.run("return (await agent('use bash', { label: 'one' })).text;");
    expect(result.ok).toBe(true);
    expect(result.value).toBe("the tool ran");
  });

  test("the run counts how many times it has asked", async () => {
    const { runtime, asks } = runtimeWith(async () => ({ approved: false }));
    await runtime.run("await agent('one'); await agent('two'); return 1;");
    expect((asks as { asked: number }[]).map((ask) => ask.asked)).toEqual([1, 2]);
  });

  test("an allow-for-this-run grant stops the second question", async () => {
    const { runtime, asks } = runtimeWith(async () => ({ approved: true, grant: ["all:shell"] }));
    const result = await runtime.run("await agent('one'); await agent('two'); return 1;");
    // The first call asked; the grant made the second call a plain allow.
    expect((asks as { asked: number }[]).length).toBe(1);
    expect(result.agents[1]!.ok).toBe(true);
  });

  test("a suspended grant only covers its own tool", async () => {
    const { runtime } = runtimeWith(async () => ({ approved: true, grant: ["all:write"] }));
    await runtime.run("await agent('one'); return 1;");
    expect(runtime.grants()).toEqual(["all:write"]);
  });

  test("with no ask callback the mode table still allows normal work", async () => {
    const { runtime } = runtimeWith();
    const result = await runtime.run("return (await agent('one')).ok;");
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
  });

  test("the grants live and die with the run", async () => {
    const first = runtimeWith(async () => ({ approved: true, grant: ["all:shell"] }));
    await first.runtime.run("await agent('one'); return 1;");
    expect(first.runtime.grants()).toEqual(["all:shell"]);
    const second = runtimeWith(async () => ({ approved: true }));
    await second.runtime.run("await agent('one'); return 1;");
    expect(second.runtime.grants()).toEqual([]);
  });

  test("the card can say 1 of 3 when the script plans three agents", async () => {
    const { runtime, asks } = runtimeWith(async () => ({ approved: true }));
    await runtime.run(
      `export const meta = { name: "demo", phases: [{ title: "A", agents: 2 }, { title: "B", agents: 1 }] };
await agent('one'); return 1;`,
    );
    expect((asks as { total?: number }[])[0]?.total).toBe(3);
  });

  test("no plan means no total, and the card says just the number", async () => {
    const { runtime, asks } = runtimeWith(async () => ({ approved: true }));
    await runtime.run("await agent('one'); return 1;");
    expect((asks as { total?: number }[])[0]?.total).toBeUndefined();
  });
});

describe("the facts a run hands to the decision", () => {
  test("a real bash call reads as a shell call with its command", () => {
    const facts = readToolFacts({ name: "bash", args: { command: "npm test" }, cwd: "/p" });
    expect(facts.command).toBe("npm test");
    expect(decideToolUse("auto", facts)).toBe("allow");
  });

  test("a destructive command asks even in auto", () => {
    const facts = readToolFacts({ name: "bash", args: { command: "git reset --hard" }, cwd: "/p" });
    expect(decideToolUse("auto", facts)).toBe("ask");
  });
});
