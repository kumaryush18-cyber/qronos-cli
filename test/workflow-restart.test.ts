import { describe, expect, test } from "bun:test";
import { restartAgent, restartRefusal, restartRequest } from "../src/workflow-restart";
import type { WorkflowAgentRecord } from "../src/workflow-types";
import type { WorkflowJob } from "../src/workflow-jobs";

const record = (overrides: Partial<WorkflowAgentRecord> = {}): WorkflowAgentRecord => ({
  id: "#0",
  label: "coding-agent",
  ok: true,
  phase: "Analyze",
  durationMs: 1_000,
  depth: 1,
  model: "claude-haiku-5.5",
  prompt: "read package.json",
  usage: { input: 100, output: 20, total: 120 },
  activity: [{ tool: "read", detail: "path: package.json", turns: 1, at: 1 }],
  toolCalls: 3,
  ...overrides,
});

const job = (overrides: Partial<WorkflowJob> = {}): WorkflowJob =>
  ({
    id: "wf_1",
    name: "demo",
    state: "done",
    startedAt: 0,
    tokens: { input: 100, output: 20, total: 120 },
    replayedTokens: { input: 0, output: 0, total: 0 },
    agents: [record(), record({ id: "#1", label: "other" })],
    phaseStats: [{ name: "Analyze", agents: 2, failed: 0, tokens: 120, durationMs: 1_000 }] as never,
    recent: [],
    live: new Map(),
    ...overrides,
  }) as unknown as WorkflowJob;

describe("the request a restart makes", () => {
  test("it repeats the same words, model and phase", () => {
    const request = restartRequest(record());
    expect(request.prompt).toBe("read package.json");
    expect(request.model).toBe("claude-haiku-5.5");
    expect(request.phase).toBe("Analyze");
  });

  test("a lost prompt says so instead of inventing one", () => {
    const request = restartRequest(record({ prompt: undefined }));
    expect(request.prompt).toContain("was not kept");
  });
});

describe("when a restart is refused", () => {
  test("a live run is refused", () => {
    expect(restartRefusal(job({ state: "running" }), "#0")).toContain("still going");
  });

  test("a paused run is refused", () => {
    expect(restartRefusal(job({ state: "paused" }), "#0")).toContain("still going");
  });

  test("a missing run is refused", () => {
    expect(restartRefusal(undefined, "#0")).toBe("no such run");
  });

  test("a missing agent is refused", () => {
    expect(restartRefusal(job(), "#9")).toBe("no such agent in this run");
  });

  test("a finished run and a real agent are allowed", () => {
    expect(restartRefusal(job(), "#0")).toBeUndefined();
  });
});

describe("running one agent again", () => {
  const runOk = async () => ({ ok: true, text: "again", usage: { input: 50, output: 5, total: 55 }, contextWindow: 200_000 });

  test("the answer replaces the old one and is marked as new work", async () => {
    const target = job();
    const outcome = await restartAgent({ job: target, agentId: "#0", runAgent: runOk as never, now: () => 9_000 });
    expect(outcome.ok).toBe(true);
    expect(target.agents[0]!.ok).toBe(true);
    expect(target.agents[0]!.restarted).toBe(true);
    expect(target.agents[0]!.restartedAt).toBe(9_000);
    expect(target.agents[0]!.replayed).toBe(false);
    expect(target.agents[0]!.usage?.total).toBe(55);
    expect(target.agents[0]!.contextWindow).toBe(200_000);
  });

  test("the tokens are spent again and the replayed total does not move", async () => {
    const target = job();
    await restartAgent({ job: target, agentId: "#0", runAgent: runOk as never, now: () => 9_000 });
    expect(target.tokens.total).toBe(175);
    expect(target.replayedTokens.total).toBe(0);
  });

  test("the other agents are not touched", async () => {
    const target = job();
    const before = JSON.parse(JSON.stringify(target.agents[1]));
    await restartAgent({ job: target, agentId: "#0", runAgent: runOk as never, now: () => 9_000 });
    expect(JSON.parse(JSON.stringify(target.agents[1]))).toEqual(before);
  });

  test("the old tool rows are gone, because they belong to the old attempt", async () => {
    const target = job();
    await restartAgent({ job: target, agentId: "#0", runAgent: runOk as never, now: () => 9_000 });
    expect(target.agents[0]!.activity).toBeUndefined();
    expect(target.agents[0]!.toolCalls).toBeUndefined();
  });

  test("a failed run is recorded as failed, not hidden", async () => {
    const target = job();
    const outcome = await restartAgent({
      job: target,
      agentId: "#0",
      runAgent: (async () => ({ ok: false, text: "", error: "model died" })) as never,
      now: () => 9_000,
    });
    expect(outcome.ok).toBe(true);
    expect(target.agents[0]!.ok).toBe(false);
    expect(target.agents[0]!.error).toBe("model died");
  });

  test("a live run is refused before any model call", async () => {
    let called = false;
    const target = job({ state: "running" });
    const outcome = await restartAgent({
      job: target,
      agentId: "#0",
      runAgent: (async () => {
        called = true;
        return { ok: true, text: "" };
      }) as never,
    });
    expect(outcome.ok).toBe(false);
    expect(called).toBe(false);
  });

  test("the journal keeps a line about it", async () => {
    const lines: unknown[] = [];
    const target = job();
    await restartAgent({
      job: target,
      agentId: "#0",
      runAgent: runOk as never,
      now: () => 9_000,
      journal: { append: (entry: unknown) => lines.push(entry) } as never,
    });
    expect(lines.length).toBe(1);
    expect(JSON.stringify(lines[0])).toContain("restarted");
  });
});

describe("running an agent again with new words", () => {
  const runEcho = (async (request: { prompt: string }) => ({
    ok: true,
    text: `did: ${request.prompt}`,
    usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, total: 60 },
  })) as never;

  test("the edited task is what the model is asked", async () => {
    let asked = "";
    const target = job();
    await restartAgent({
      job: target,
      agentId: "#0",
      prompt: "read the writer instead",
      runAgent: (async (request: { prompt: string }) => {
        asked = request.prompt;
        return { ok: true, text: "" };
      }) as never,
    });
    expect(asked).toBe("read the writer instead");
  });

  test("the record keeps the words that were really used", async () => {
    const target = job();
    const outcome = await restartAgent({ job: target, agentId: "#0", prompt: "  read the writer  ", runAgent: runEcho });
    expect(outcome.ok).toBe(true);
    const agent = target.agents[0]!;
    expect(agent.prompt).toBe("read the writer");
  });

  test("an empty edit is the same task it had", async () => {
    let asked = "";
    const target = job();
    await restartAgent({
      job: target,
      agentId: "#0",
      prompt: "   ",
      runAgent: (async (request: { prompt: string }) => {
        asked = request.prompt;
        return { ok: true, text: "" };
      }) as never,
    });
    expect(asked).toBe("read package.json");
  });

  test("the history holds one entry per run again, with what it cost", async () => {
    const target = job();
    await restartAgent({ job: target, agentId: "#0", runAgent: runEcho, now: () => 5_000 });
    await restartAgent({ job: target, agentId: "#0", prompt: "new words", runAgent: runEcho, now: () => 6_000 });
    const attempts = target.agents[0]!.attempts ?? [];
    expect(attempts.length).toBe(2);
    expect(attempts[0]!.tokens).toBe(60);
    expect(attempts[0]!.prompt).toBeUndefined();
    expect(attempts[1]!.prompt).toBe("new words");
    expect(attempts[1]!.at).toBe(6_000);
  });

  test("the history is capped, so a record never grows for ever", async () => {
    const target = job();
    for (let run = 0; run < 8; run += 1) {
      await restartAgent({ job: target, agentId: "#0", runAgent: runEcho });
    }
    expect(target.agents[0]!.attempts!.length).toBe(5);
  });

  test("the bill rises by the edited attempt, and the replay count does not", async () => {
    const target = job();
    await restartAgent({ job: target, agentId: "#0", prompt: "new words", runAgent: runEcho });
    expect(target.tokens.total).toBe(180);
    expect(target.replayedTokens.total).toBe(0);
  });

  test("the other agents keep their history", async () => {
    const target = job();
    await restartAgent({ job: target, agentId: "#0", prompt: "new words", runAgent: runEcho });
    expect(target.agents[1]!.attempts).toBeUndefined();
    expect(target.agents[1]!.restarted).toBeUndefined();
  });
});
