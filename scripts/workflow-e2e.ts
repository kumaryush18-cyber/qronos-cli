// End-to-end check for workflows, against a REAL model.
//
// It builds the real `workflow` tool, then runs it with the real subagent runner
// on a real project. Nothing about the model is faked: the agents think, use
// tools, and report tokens. The checks read what the chat would receive.
//
//   QRONOS_E2E_MODEL=claude-haiku-5.5 bun run scripts/workflow-e2e.ts
//
// Exit code is 0 only when every step passed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ModelRegistry, createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { loadJwt } from "../src/credentials";
import { getCredentialsPath, getQronosAgentDir } from "../src/paths";
import { PROVIDER_PRESETS } from "../src/provider";
import { createWorkflowToolExtension, renderWorkflowReport, getLastWorkflowRun } from "../src/workflow-tool";
import { workflowConfigFromEnv } from "../src/workflow-types";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const scratch = mkdtempSync(join(tmpdir(), "qronos-workflow-e2e-"));
const project = join(scratch, "demo-project");
const agentDir = join(scratch, "agent");
mkdirSync(join(project, ".git"), { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(
  join(project, "src", "auth.ts"),
  "export function checkSession(token?: string) {\n  if (!token) return false;\n  return token.length > 8;\n}\n",
);
writeFileSync(
  join(project, "src", "open.ts"),
  "export function listUsers() {\n  // no session check here on purpose\n  return [];\n}\n",
);
writeFileSync(join(project, "src", "sum.ts"), "export function sum(a: number, b: number) {\n  return a + b;\n}\n");

const apiKey = (await loadJwt(getCredentialsPath(getQronosAgentDir()))) || process.env.QRONOS_API_KEY || "";
if (!apiKey) {
  console.error("No credentials found. Run `qronos-cli` and log in first.");
  process.exit(2);
}

const modelId = process.env.QRONOS_E2E_MODEL || "claude-haiku-5.5";
const opts: LaunchOptions = {
  baseUrl: process.env.QRONOS_API_BASE || PROVIDER_PRESETS.qronos.baseUrl,
  jwt: apiKey,
  agentDir,
  model: modelId,
};
const { settingsManager, resourceLoaderOptions } = buildRuntimeOptions(opts, `workflow-e2e-${Date.now()}`);
const services = await createAgentSessionServices({ cwd: project, agentDir, settingsManager, resourceLoaderOptions });
const registry = new ModelRegistry(services.modelRuntime);
await registry.refresh();
const model = registry.find("qronos", modelId) ?? registry.getAvailable().find((item) => item.id === modelId);
if (!model) throw new Error("no chat model in the registry");

/* --- the smallest honest tool surface: read, ls, grep -------------------- */

const readTool = {
  name: "read",
  description: "Read a file from the project.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};
const lsTool = {
  name: "ls",
  description: "List a directory.",
  parameters: { type: "object", properties: { path: { type: "string" } } },
};
const grepTool = {
  name: "grep",
  description: "Search file contents.",
  parameters: {
    type: "object",
    properties: { pattern: { type: "string" }, path: { type: "string" } },
    required: ["pattern"],
  },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === ".git" || entry === "node_modules") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const statuses: Array<{ key: string; text?: string }> = [];
const ctx = {
  cwd: project,
  model,
  modelRegistry: registry,
  signal: new AbortController().signal,
  ui: {
    setStatus: (key: string, text?: string) => statuses.push({ key, text }),
    notify: () => {},
  },
  tools: [readTool, lsTool, grepTool] as never,
  async executeTool(name: string, args: any) {
    try {
      if (name === "read") {
        const target = join(project, args?.path ?? "");
        return { result: { content: [{ type: "text", text: readFileSync(target, "utf8") }] }, isError: false };
      }
      if (name === "ls") {
        const dir = join(project, args?.path ?? ".");
        return { result: { content: [{ type: "text", text: readdirSync(dir).join("\n") }] }, isError: false };
      }
      if (name === "grep") {
        const pattern = new RegExp(String(args?.pattern ?? ""), "i");
        const hits = walk(project)
          .map((file) => ({ file, lines: readFileSync(file, "utf8").split("\n") }))
          .flatMap(({ file, lines }) =>
            lines.map((line, index) => (pattern.test(line) ? `${relative(project, file)}:${index + 1}: ${line.trim()}` : "")),
          )
          .filter(Boolean);
        return { result: { content: [{ type: "text", text: hits.join("\n") || "no matches" }] }, isError: false };
      }
      return { result: { content: [{ type: "text", text: `unknown tool ${name}` }] }, isError: true };
    } catch (error) {
      return { result: { content: [{ type: "text", text: String(error) }] }, isError: true };
    }
  },
} as never;

/* --- capture the tool the extension registers --------------------------- */

const tools: Array<Record<string, any>> = [];
createWorkflowToolExtension({
  config: { ...workflowConfigFromEnv({}), wallClockMs: 600_000, concurrency: 4, maxAgents: 12 },
}).factory({
  registerTool: (tool: Record<string, any>) => tools.push(tool),
  registerCommand: () => {},
  registerShortcut: () => {},
  on: () => {},
} as never);
const workflowTool = tools[0]!;
const run = (params: Record<string, unknown>) =>
  workflowTool.execute("e2e-1", params, new AbortController().signal, () => {}, ctx) as Promise<{
    content: Array<{ text: string }>;
    details: Record<string, any>;
  }>;

try {
  console.log(`model: ${modelId}\nproject: ${project}\n`);

  /* 1. a real fan-out with a schema, three files ---------------------------------- */
  const fanout = await run({
    name: "auth-audit",
    script: `
      phase("Understand")
      const files = await agent(
        "List the .ts files inside src/ of this project. Answer as JSON.",
        { label: "list files", schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } } },
      )
      phase("Review")
      const names = files.ok && Array.isArray(files.data?.files) ? files.data.files : ["src/auth.ts", "src/open.ts"]
      const reports = await pipeline(names, (file) =>
        agent(
          "Read " + file + " and say in one short sentence whether it checks a session before doing its work.",
          { label: String(file) },
        ),
      )
      return reports.map((r) => ({ ok: r.ok, text: r.text.slice(0, 200) }))
    `,
  });

  const detail = fanout.details;
  check("the workflow finished", detail.ok === true, String(detail.error ?? ""));
  check("at least three agents ran", (detail.agents ?? 0) >= 3, `${detail.agents} agents`);
  check("tokens were reported per run", (detail.tokens?.total ?? 0) > 0, `${detail.tokens?.total} tokens`);
  const last = getLastWorkflowRun();
  const withTokens = (last?.result.agents ?? []).filter((agent) => (agent.usage?.total ?? 0) > 0);
  check("each agent carries its own token count", withTokens.length >= 2, `${withTokens.length} agents with tokens`);
  check("phases were named", (last?.result.phases ?? []).includes("Review"), (last?.result.phases ?? []).join(", "));
  const phaseTokens = (last?.result.phaseStats ?? []).filter((stat) => stat.tokens > 0);
  check("phases carry token totals", phaseTokens.length >= 1, `${phaseTokens.length} phases with tokens`);
  check("the report shows a phase table", /▸\s/.test(fanout.content[0]!.text) || fanout.content[0]!.text.includes("Understand"));
  check("the live status line was published", statuses.some((entry) => entry.key === "qronos-workflow"));
  check("the status line is cleared at the end", statuses.at(-1)?.text === undefined);

  /* 2. a nested workflow, one child level ---------------------------------------- */
  const nested = await run({
    name: "nested",
    script: `
      phase("Understand")
      const outer = await agent("Say the word OUTER and nothing else.", { label: "outer" })
      const inner = await workflow("return (await agent('Say the word INNER and nothing else.', { label: 'inner' })).text")
      return { outer: outer.text.slice(0, 80), inner: String(inner).slice(0, 80) }
    `,
  });
  const nestedAgents = getLastWorkflowRun()?.result.agents ?? [];
  check("the nested workflow ran", nested.details.ok === true, String(nested.details.error ?? ""));
  check("a child agent is recorded with depth 2", nestedAgents.some((agent) => agent.depth === 2), `${nestedAgents.length} agents`);
  check(
    "nested agents count against the same budget",
    nestedAgents.length >= 2 && nested.details.agents === nestedAgents.length,
    `${nested.details.agents} agents`,
  );

  /* 3. a per-agent model choice --------------------------------------------------- */
  const routed = await run({
    name: "routed",
    script: `
      const a = await agent("Reply with the single word PINEAPPLE.", { label: "routed", model: "${modelId}" })
      return { ok: a.ok, head: a.text.slice(0, 60) }
    `,
  });
  check("an agent can be routed to a named model", routed.details.ok === true, String(routed.details.error ?? ""));

  /* 4. the caps are real ----------------------------------------------------------- */
  const capped = await run({
    name: "capped",
    script: `
      for (let i = 0; i < 20; i += 1) { await agent("Say OK " + i) }
      return "finished"
    `,
  });
  check("the agent cap stops a runaway script", capped.details.ok === false, String(capped.details.error ?? "not stopped"));
  check("the cap message names the env var", String(capped.details.error ?? "").includes("QRONOS_WORKFLOW_MAX_AGENTS"));

  console.log("\n--- the report the chat receives ---");
  console.log(renderWorkflowReport("auth-audit", getLastWorkflowRun()!.result));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failures.length === 0) {
  console.log("ALL CHECKS PASSED");
  process.exit(0);
}
console.log(`${failures.length} CHECK(S) FAILED: ${failures.join(", ")}`);
process.exit(1);
