import { describe, expect, test } from "bun:test";
import type { ExtensionAPI, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { AgentRegistry } from "../src/agent-registry";
import { checkAgainstSchema } from "../src/agent-tool";
import {
  AGENT_TOOL_NAME,
  createAgentToolExtension,
  defaultSubagentRunner,
  capSubagentOutput,
  runWithConcurrency,
  resolveSubagentToolNames,
  SUBAGENT_MAX_OUTPUT_CHARS,
  SUBAGENT_READ_ONLY_TOOLS,
} from "../src/agent-tool";

describe("createAgentToolExtension (Item ⑦: Subagents with Option B)", () => {
  test("registers agent tool with description, prompt, and subagent_type parameters", () => {
    let registeredTool: any = null;
    const fakePi = {
      registerTool: (tool: any) => {
        registeredTool = tool;
      },
    } as unknown as ExtensionAPI;

    const ext = createAgentToolExtension();
    expect(ext.name).toBe("qronos-agent");
    (ext as any).factory(fakePi);

    expect(registeredTool).not.toBeNull();
    expect(registeredTool.name).toBe(AGENT_TOOL_NAME);
    expect(registeredTool.parameters.properties.prompt).toBeDefined();
    expect(registeredTool.parameters.properties.description).toBeDefined();
    expect(registeredTool.parameters.properties.subagent_type).toBeDefined();
  });

  test("Option B: SUBAGENT_READ_ONLY_TOOLS strictly excludes mutating tools and agent recursion", () => {
    expect(SUBAGENT_READ_ONLY_TOOLS.has("read")).toBe(true);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("grep")).toBe(true);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("enter_plan_mode")).toBe(true);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("exit_plan_mode")).toBe(true);

    // Mutating tools must be forbidden
    expect(SUBAGENT_READ_ONLY_TOOLS.has("write")).toBe(false);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("write_file")).toBe(false);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("edit")).toBe(false);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("edit_file")).toBe(false);
    // Recursion forbidden
    expect(SUBAGENT_READ_ONLY_TOOLS.has("agent")).toBe(false);
    expect(SUBAGENT_READ_ONLY_TOOLS.has("subagent")).toBe(false);
  });

  test("executes subagent with runner and returns formatted summary", async () => {
    let runnerCalled = false;
    const fakeRunner = async (params: any) => {
      runnerCalled = true;
      expect(params.prompt).toBe("Search for auth handlers");
      expect(params.description).toBe("Find auth code");
      return {
        output: "Found auth handlers in src/auth.ts:15",
        turns: 2,
        toolsUsed: ["read", "grep"],
        planApproved: false,
      };
    };

    let registeredTool: any = null;
    const fakePi = {
      registerTool: (tool: any) => {
        registeredTool = tool;
      },
    } as unknown as ExtensionAPI;

    const ext = createAgentToolExtension({ runner: fakeRunner });
    (ext as any).factory(fakePi);

    const fakeCtx = {
      cwd: "/test/project",
      ui: { notify: () => {} },
    } as unknown as ExtensionToolContext;

    const result = await registeredTool.execute(
      "call-1",
      {
        description: "Find auth code",
        prompt: "Search for auth handlers",
        subagent_type: "Explore",
      },
      undefined,
      undefined,
      fakeCtx,
    );

    expect(runnerCalled).toBe(true);
    expect(result.content[0].text).toContain("Subagent [Explore] completed task");
    expect(result.content[0].text).toContain("Found auth handlers in src/auth.ts:15");
    expect(result.details.ok).toBe(true);
    expect(result.details.turns).toBe(2);
    expect(result.details.toolsUsed).toEqual(["read", "grep"]);
  });

  test("handles plan approval reflection in subagent results", async () => {
    const fakeRunner = async () => ({
      output: "Created implementation plan.",
      turns: 3,
      toolsUsed: ["read", "exit_plan_mode"],
      planApproved: true,
    });

    let registeredTool: any = null;
    const fakePi = {
      registerTool: (tool: any) => {
        registeredTool = tool;
      },
    } as unknown as ExtensionAPI;

    const ext = createAgentToolExtension({ runner: fakeRunner });
    (ext as any).factory(fakePi);

    const fakeCtx = {
      cwd: "/test/project",
      ui: { notify: () => {} },
    } as unknown as ExtensionToolContext;

    const result = await registeredTool.execute(
      "call-2",
      {
        description: "Draft architecture plan",
        prompt: "Plan the new feature",
        subagent_type: "Plan",
      },
      undefined,
      undefined,
      fakeCtx,
    );

    expect(result.content[0].text).toContain("Plan: Approved ✓");
    expect(result.details.planApproved).toBe(true);
  });
});

describe("Option B: custom agent definitions cannot escalate privileges", () => {
  // Regression for a real hole: a definition's `tools:` list used to REPLACE
  // the read-only default, so `tools: write, edit, bash` in
  // qronos/agents/*.md granted a subagent full write access.
  function agentWithTools(tools: string[] | undefined) {
    return {
      name: "x",
      description: "x",
      tools,
      systemPrompt: "",
      source: "project" as const,
    };
  }

  test("write/edit/bash are stripped from a definition that asks for them", () => {
    const allowed = resolveSubagentToolNames(agentWithTools(["write", "edit", "bash", "read"]));
    expect(allowed.has("write")).toBe(false);
    expect(allowed.has("edit")).toBe(false);
    expect(allowed.has("bash")).toBe(false);
    expect(allowed.has("read")).toBe(true);
  });

  test("a definition asking ONLY for forbidden tools falls back to the read-only set", () => {
    const allowed = resolveSubagentToolNames(agentWithTools(["write", "edit"]));
    expect(allowed.size).toBeGreaterThan(0);
    expect(allowed.has("write")).toBe(false);
    expect(allowed.has("read")).toBe(true);
  });

  test("no forbidden tool is ever reachable, for any definition shape", () => {
    const forbidden = ["write", "write_file", "edit", "edit_file", "bash", "agent", "subagent"];
    for (const tools of [undefined, [], forbidden, ["read", "write"], ["bash"]]) {
      const allowed = resolveSubagentToolNames(agentWithTools(tools as string[] | undefined));
      for (const f of forbidden) expect(allowed.has(f)).toBe(false);
    }
  });

  test("recursion is removed even if a definition asks for the agent tool", () => {
    const allowed = resolveSubagentToolNames(agentWithTools(["agent", "subagent", "read"]));
    expect(allowed.has("agent")).toBe(false);
    expect(allowed.has("subagent")).toBe(false);
  });

  test("a definition may still narrow the set to a read-only subset", () => {
    const allowed = resolveSubagentToolNames(agentWithTools(["grep", "read"]));
    expect([...allowed].sort()).toEqual(["grep", "read"]);
  });
});

describe("parallel fan-out respects the concurrency cap", () => {
  test("runs every item and preserves input order", async () => {
    const out = await runWithConcurrency([1, 2, 3, 4, 5], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40, 50]);
  });

  test("never exceeds the limit at any instant", async () => {
    let live = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async () => {
      live++;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 5));
      live--;
      return null;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  test("a limit larger than the work still completes", async () => {
    const out = await runWithConcurrency(["a", "b"], 100, async (x) => x.toUpperCase());
    expect(out).toEqual(["A", "B"]);
  });

  test("an invalid limit degrades to serial instead of hanging", async () => {
    const out = await runWithConcurrency([1, 2], 0, async (n) => n);
    expect(out).toEqual([1, 2]);
  });

  test("empty input resolves to an empty array", async () => {
    expect(await runWithConcurrency([], 4, async () => 1)).toEqual([]);
  });
});

describe("Option B: subagent output is capped", () => {
  test("short output passes through unchanged", () => {
    expect(capSubagentOutput("done")).toBe("done");
  });

  test("output at the cap is untouched", () => {
    const exact = "x".repeat(SUBAGENT_MAX_OUTPUT_CHARS);
    expect(capSubagentOutput(exact)).toBe(exact);
  });

  test("oversized output is truncated with a marker the model can act on", () => {
    const huge = "y".repeat(SUBAGENT_MAX_OUTPUT_CHARS * 2);
    const out = capSubagentOutput(huge);
    expect(out.length).toBeLessThan(huge.length);
    expect(out).toContain("subagent output truncated");
    expect(out.startsWith("y")).toBe(true);
  });
});

describe("agent registry wiring (Agent Hub part A)", () => {
  const build = (runner: any, registry: AgentRegistry) => {
    let tool: any = null;
    const statuses: Array<[string, string | undefined]> = [];
    const pi = { registerTool: (t: any) => (tool = t) } as unknown as ExtensionAPI;
    (createAgentToolExtension({ runner, registry }) as any).factory(pi);
    const ctx = {
      cwd: "/test/project",
      ui: {
        notify: () => {},
        setStatus: (key: string, text?: string) => statuses.push([key, text]),
      },
    } as unknown as ExtensionToolContext;
    return { tool, ctx, statuses };
  };

  test("a successful subagent is registered, then marked done", async () => {
    const registry = new AgentRegistry();
    const runner = async (params: any) => {
      params.onEvent?.({ turns: 1, tool: "read" });
      params.onEvent?.({ turns: 2, tool: "grep" });
      return { output: "found it", turns: 2, toolsUsed: ["read", "grep"] };
    };
    const { tool, ctx } = build(runner, registry);

    await tool.execute("c1", { description: "find auth", prompt: "go", subagent_type: "Explore" }, undefined, undefined, ctx);

    const [record] = registry.list();
    expect(record.description).toBe("find auth");
    expect(record.type).toBe("Explore");
    expect(record.status).toBe("done");
    expect(record.turns).toBe(2);
    expect(record.toolsUsed).toEqual(["read", "grep"]);
    expect(record.outputChars).toBe("found it".length);
  });

  test("a throwing runner leaves the agent marked failed, and the error still reaches the model", async () => {
    const registry = new AgentRegistry();
    const runner = async () => {
      throw new Error("model went away");
    };
    const { tool, ctx } = build(runner, registry);

    await expect(
      tool.execute("c1", { description: "boom", prompt: "go" }, undefined, undefined, ctx),
    ).rejects.toThrow("model went away");

    const [record] = registry.list();
    expect(record.status).toBe("failed");
    expect(record.error).toBe("model went away");
  });

  test("the footer status line follows the registry", async () => {
    const registry = new AgentRegistry();
    const runner = async (params: any) => {
      params.onEvent?.({ turns: 1 });
      return { output: "ok", turns: 1, toolsUsed: [] };
    };
    const { tool, ctx, statuses } = build(runner, registry);

    await tool.execute("c1", { description: "status test", prompt: "go" }, undefined, undefined, ctx);

    const texts = statuses.filter(([key]) => key === "qronos-agents").map(([, text]) => text);
    expect(texts[0]).toContain("1 agent");
    expect(texts.at(-1)).toContain("done");
  });

  test("fan-out registers one agent per task", async () => {
    const registry = new AgentRegistry();
    const runner = async (params: any) => {
      params.onEvent?.({ turns: 1, tool: "read" });
      return { output: "ok", turns: 1, toolsUsed: ["read"] };
    };
    const { tool, ctx } = build(runner, registry);

    await tool.execute(
      "c1",
      {
        description: "fan out",
        prompt: "ignored",
        tasks: [
          { description: "one", prompt: "a" },
          { description: "two", prompt: "b" },
          { description: "three", prompt: "c" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );

    expect(registry.list().map((r) => r.description)).toEqual(["one", "two", "three"]);
    expect(registry.list().every((r) => r.status === "done")).toBe(true);
  });
});

describe("typed results (Agent Hub part B)", () => {
  const REPORT_SCHEMA = {
    type: "object",
    required: ["summary", "files"],
    properties: { summary: { type: "string" }, files: { type: "array", items: { type: "string" } } },
  };

  const build = (runner: any) => {
    let tool: any = null;
    const pi = { registerTool: (t: any) => (tool = t) } as unknown as ExtensionAPI;
    (createAgentToolExtension({ runner, registry: new AgentRegistry() }) as any).factory(pi);
    const ctx = { cwd: "/test/project", ui: { notify: () => {}, setStatus: () => {} } } as unknown as ExtensionToolContext;
    return { tool, ctx };
  };

  test("the schema reaches the runner", async () => {
    let seen: unknown;
    const runner = async (params: any) => {
      seen = params.outputSchema;
      return { output: "{}", turns: 1, toolsUsed: [], structured: { value: {}, firstTry: true } };
    };
    const { tool, ctx } = build(runner);
    await tool.execute("c", { description: "d", prompt: "p", output_schema: REPORT_SCHEMA }, undefined, undefined, ctx);
    expect(seen).toEqual(REPORT_SCHEMA);
  });

  test("a matching answer comes back as a value in details", async () => {
    const value = { summary: "fine", files: ["a.ts"] };
    const runner = async () => ({
      output: JSON.stringify(value),
      turns: 2,
      toolsUsed: [],
      structured: { value, firstTry: true },
    });
    const { tool, ctx } = build(runner);
    const result = await tool.execute(
      "c",
      { description: "d", prompt: "p", output_schema: REPORT_SCHEMA },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details.structured).toEqual(value);
    expect(result.details.schemaMismatched).toBe(false);
    expect(result.content[0].text).toContain("Schema: satisfied");
    expect(result.content[0].text).toContain(JSON.stringify(value));
  });

  test("a repaired answer says so", async () => {
    const value = { summary: "fixed", files: ["b.ts"] };
    const runner = async () => ({
      output: JSON.stringify(value),
      turns: 3,
      toolsUsed: [],
      structured: { value, firstTry: false },
    });
    const { tool, ctx } = build(runner);
    const result = await tool.execute(
      "c",
      { description: "d", prompt: "p", output_schema: REPORT_SCHEMA },
      undefined,
      undefined,
      ctx,
    );
    expect(result.content[0].text).toContain("after one repair turn");
  });

  test("a mismatched answer is never silently accepted", async () => {
    const runner = async () => ({
      output: "I looked around but found nothing useful.",
      turns: 2,
      toolsUsed: [],
      schemaIssues: [{ path: "files", message: "is required" }],
    });
    const { tool, ctx } = build(runner);
    const result = await tool.execute(
      "c",
      { description: "d", prompt: "p", output_schema: REPORT_SCHEMA },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details.structured).toBeNull();
    expect(result.details.schemaMismatched).toBe(true);
    expect(result.content[0].text).toContain("NOT satisfied");
    expect(result.content[0].text).toContain("- files: is required");
  });

  test("no schema means no schema notes at all", async () => {
    const runner = async () => ({ output: "plain prose", turns: 1, toolsUsed: [] });
    const { tool, ctx } = build(runner);
    const result = await tool.execute("c", { description: "d", prompt: "p" }, undefined, undefined, ctx);
    expect(result.content[0].text).not.toContain("Schema:");
    expect(result.details.structured).toBeNull();
  });

  test("fan-out returns one structured entry per task, in order", async () => {
    const runner = async (params: any) => {
      const value = { summary: params.description, files: [params.description] };
      return { output: JSON.stringify(value), turns: 1, toolsUsed: [], structured: { value, firstTry: true } };
    };
    const { tool, ctx } = build(runner);
    const result = await tool.execute(
      "c",
      {
        description: "fan out",
        prompt: "ignored",
        output_schema: REPORT_SCHEMA,
        tasks: [
          { description: "one", prompt: "a" },
          { description: "two", prompt: "b" },
        ],
      },
      undefined,
      undefined,
      ctx,
    );
    expect(result.details.structured).toEqual([
      { summary: "one", files: ["one"] },
      { summary: "two", files: ["two"] },
    ]);
    expect(result.details.schemaMismatched).toBe(0);
  });

  test("checkAgainstSchema separates 'not JSON' from 'wrong shape'", () => {
    expect(checkAgainstSchema("no json here", REPORT_SCHEMA).issues[0].message).toBe(
      "the answer is not valid JSON",
    );
    expect(checkAgainstSchema('{"summary":"x"}', REPORT_SCHEMA).issues[0]).toEqual({
      path: "files",
      message: "is required",
    });
    expect(checkAgainstSchema('{"summary":"x","files":["a"]}', REPORT_SCHEMA).value).toEqual({
      summary: "x",
      files: ["a"],
    });
    // Fenced JSON is accepted: the model often wraps it.
    expect(checkAgainstSchema('```json\n{"summary":"x","files":[]}\n```', REPORT_SCHEMA).value).toEqual({
      summary: "x",
      files: [],
    });
  });
});
