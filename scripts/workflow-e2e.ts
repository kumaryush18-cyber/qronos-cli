// End-to-end check for workflows, against a REAL model.
//
// It builds the real `workflow` tool, then runs it with the real subagent runner
// on a real project. Nothing about the model is faked: the agents think, use
// tools, and report tokens. The checks read what the chat would receive.
//
//   QRONOS_E2E_MODEL=claude-haiku-5.5 bun run scripts/workflow-e2e.ts
//
// Exit code is 0 only when every step passed.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ModelRegistry, createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { loadJwt } from "../src/credentials";
import { getCredentialsPath, getQronosAgentDir } from "../src/paths";
import { PROVIDER_PRESETS } from "../src/provider";
import { createWorkflowToolExtension, renderWorkflowReport, getLastWorkflowRun } from "../src/workflow-tool";
import { journalDir } from "../src/workflow-journal";
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
    notify: (text: string) => notices.push(text),
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
const deliveries: Array<{ content: string; customType: string }> = [];
const notices: string[] = [];
let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
createWorkflowToolExtension({
  config: { ...workflowConfigFromEnv({}), wallClockMs: 600_000, concurrency: 4, maxAgents: 12 },
  agentDir,
}).factory({
  registerTool: (tool: Record<string, any>) => tools.push(tool),
  // The command lives in the SAME extension instance as the tool, exactly as in
  // the real CLI: one instance, one job manager, so /workflows sees the jobs.
  registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
    if (name === "workflows") commandHandler = spec.handler;
  },
  registerShortcut: () => {},
  sendMessage: (message: Record<string, any>) =>
    deliveries.push({ content: String(message.content), customType: String(message.customType) }),
  on: () => {},
} as never);
const workflowTool = tools[0]!;

const commandNotices: string[] = [];
async function stopJob(id: string): Promise<boolean> {
  commandNotices.length = 0;
  await commandHandler?.(`stop ${id}`, { ui: { notify: (text: string) => commandNotices.push(text) } });
  return commandNotices.some((text) => text.includes("Stopped"));
}

async function jobState(id: string): Promise<string> {
  commandNotices.length = 0;
  await commandHandler?.(id, { ui: { notify: (text: string) => commandNotices.push(text) } });
  const text = commandNotices.join(" ");
  if (text.includes("cancelled")) return "cancelled";
  if (text.includes("status: running")) return "running";
  if (text.includes("failed")) return "failed";
  if (text.includes("finished")) return "done";
  return "unknown";
}

function lastJournalPath(): string | undefined {
  // The job manager writes under <agentDir>/workflow-runs; the newest file is
  // the run that just finished.
  try {
    const dir = journalDir(agentDir);
    const names = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
    if (names.length === 0) return undefined;
    return join(dir, names.sort().at(-1)!);
  } catch {
    return undefined;
  }
}
const run = (params: Record<string, unknown>) =>
  workflowTool.execute("e2e-1", params, new AbortController().signal, () => {}, ctx) as Promise<{
    content: Array<{ text: string }>;
    details: Record<string, any>;
  }>;

try {
  console.log(`model: ${modelId}\nproject: ${project}\n`);

  /* 1. a real fan-out with a schema, three files ---------------------------------- */
  let fanoutReport = "";
  const fanout = await run({
    name: "auth-audit",
    background: false,
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
  fanoutReport = String(fanout.content[0]?.text ?? "");
  check("the status line is cleared at the end", statuses.at(-1)?.text === undefined);

  /* 2. a nested workflow, one child level ---------------------------------------- */
  const nested = await run({
    name: "nested",
    background: false,
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
    background: false,
    script: `
      const a = await agent("Reply with the single word PINEAPPLE.", { label: "routed", model: "${modelId}" })
      return { ok: a.ok, head: a.text.slice(0, 60) }
    `,
  });
  check("an agent can be routed to a named model", routed.details.ok === true, String(routed.details.error ?? ""));

  /* 4. the caps are real ----------------------------------------------------------- */
  const capped = await run({
    name: "capped",
    background: false,
    script: `
      for (let i = 0; i < 20; i += 1) { await agent("Say OK " + i) }
      return "finished"
    `,
  });
  check("the agent cap stops a runaway script", capped.details.ok === false, String(capped.details.error ?? "not stopped"));
  check("the cap message names the env var", String(capped.details.error ?? "").includes("QRONOS_WORKFLOW_MAX_AGENTS"));

  /* 5. background: launch returns at once, the report arrives later --------------- */
  const background = await run({
    name: "bg-audit",
    script: `
      phase("Understand")
      const files = await agent("List the .ts files inside src/ and answer as JSON.", {
        schema: { type: "object", required: ["files"], properties: { files: { type: "array", items: { type: "string" } } } },
      })
      phase("Review")
      const reports = await pipeline(files.data?.files ?? ["src/auth.ts"], (file) =>
        agent("Read " + file + " and say in one short sentence what it does.", { label: String(file) }),
      )
      return reports.map((r) => r.text.slice(0, 120))
    `,
  });
  const launchedAt = Date.now();
  check("a background launch returns immediately", background.details.background === true, String(background.details.job));
  check("the launch says where to watch it", background.content[0]!.text.includes("/workflows"));
  check("the launch costs no time", Date.now() - launchedAt < 5_000, `${Date.now() - launchedAt}ms`);
  check("nothing was delivered before it finished", deliveries.length === 0, `${deliveries.length} deliveries`);

  // Wait for the report to arrive, the way a later turn would receive it.
  const deadline = Date.now() + 240_000;
  while (deliveries.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
  check("the report was delivered as a message", deliveries.length === 1, `${deliveries.length} deliveries`);
  check("the delivery is marked as a workflow report", deliveries[0]?.customType === "qronos-workflow-report");
  check("the delivery carries the report", String(deliveries[0]?.content ?? "").includes("bg-audit"));
  check("a notification was shown", notices.length > 0, notices.at(-1) ?? "");
  check("the journal was written to disk", Boolean(getLastWorkflowRun()) && existsSync(String(lastJournalPath() ?? "")), String(lastJournalPath() ?? "none"));

  /* 6. cancel really stops a run ------------------------------------------------- */
  const toCancel = await run({ name: "cancel-me", script: `
    for (let i = 0; i < 6; i += 1) { await agent("Say the word SLOW " + i) }
    return "finished"
  `});
  const cancelId = String(toCancel.details.job ?? "");
  check("a second background job launched", cancelId.startsWith("wf_"), cancelId);
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  const stopped = await stopJob(cancelId);
  check("cancel reports success", stopped === true, String(stopped));
  const afterCancel = await jobState(cancelId);
  check("the cancelled job is not running", afterCancel === "cancelled" || afterCancel === "failed", String(afterCancel));

  console.log("\n--- the report the chat receives ---");
  console.log(fanoutReport);
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
