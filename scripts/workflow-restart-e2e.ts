// End-to-end check for P6: run one agent of a finished run again.
//
// Real tool, real model, real project. Two agents finish; the card is answered
// "no" once (which must change nothing) and "yes" once. The checks read the job
// back through `/workflows <id>`, so they are about what a user would see.
//
//   QRONOS_E2E_MODEL=claude-haiku-5.5 bun run scripts/workflow-restart-e2e.ts
//
// Exit code is 0 only when every check passed.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRegistry, createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { loadJwt } from "../src/credentials";
import { getCredentialsPath, getQronosAgentDir } from "../src/paths";
import { PROVIDER_PRESETS } from "../src/provider";
import { createWorkflowToolExtension } from "../src/workflow-tool";
import { workflowConfigFromEnv } from "../src/workflow-types";
import { initExecutionMode } from "../src/execution-modes";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const scratch = mkdtempSync(join(tmpdir(), "qronos-workflow-restart-e2e-"));
const project = join(scratch, "demo-project");
const agentDir = join(scratch, "agent");
mkdirSync(join(project, ".git"), { recursive: true });
writeFileSync(join(project, "a.txt"), "alpha\n");
writeFileSync(join(project, "b.txt"), "beta\n");

const apiKey = (await loadJwt(getCredentialsPath(getQronosAgentDir()))) || process.env.QRONOS_API_KEY || "";
if (!apiKey) {
  console.error("No qronos session found. Run `qronos-cli` and log in first.");
  process.exit(2);
}

const modelId = process.env.QRONOS_E2E_MODEL || "claude-haiku-5.5";
const opts: LaunchOptions = {
  baseUrl: process.env.QRONOS_API_BASE || PROVIDER_PRESETS.qronos.baseUrl,
  jwt: apiKey,
  agentDir,
  model: modelId,
};
const { settingsManager, resourceLoaderOptions } = buildRuntimeOptions(opts, `wf-restart-e2e-${Date.now()}`);
const services = await createAgentSessionServices({ cwd: project, agentDir, settingsManager, resourceLoaderOptions });
const registry = new ModelRegistry(services.modelRuntime);
await registry.refresh();
const model = registry.find("qronos", modelId) ?? registry.getAvailable().find((item) => item.id === modelId);
if (!model) throw new Error("no chat model in the registry");
initExecutionMode(false, "auto");

const tools = [
  {
    name: "read",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

/** The keys the test presses on each card, in order: the start card first. */
const keyPlan: string[][] = [["\r"]];
let cardIndex = 0;
const cards: string[] = [];

const ctx = {
  cwd: project,
  model,
  modelRegistry: registry,
  signal: new AbortController().signal,
  ui: {
    setStatus: () => {},
    notify: () => {},
    custom: async (build: any, options: Record<string, unknown>) => {
      const keys = keyPlan[cardIndex] ?? [];
      cardIndex += 1;
      const component = build({ requestRender: () => {} }, { fg: (_slot: string, text: string) => text }, {}, () => {});
      const drawn = component.render(66).map((line: string) => line.replace(/\u001b\[[0-9;]*m/g, ""));
      cards.push(drawn.join("\n"));
      check(`a card was shown (${options.overlay ? "overlay" : "inline"})`, true, drawn[1]?.trim().slice(0, 48) ?? "");
      for (const key of keys) component.handleInput(key);
      return undefined;
    },
  },
  tools: tools as never,
  async executeTool(name: string, args: any) {
    if (name === "read") {
      const { readFileSync } = await import("node:fs");
      return {
        result: { content: [{ type: "text", text: readFileSync(join(project, String(args?.path ?? "")), "utf8") }] },
        isError: false,
      };
    }
    return { result: { content: [{ type: "text", text: "unknown tool" }] }, isError: true };
  },
};

const commands: Array<(args: string, ctx: unknown) => Promise<void>> = [];
createWorkflowToolExtension({
  config: { ...workflowConfigFromEnv({}), wallClockMs: 240_000, concurrency: 2, maxAgents: 6 },
  agentDir,
}).factory({
  registerTool: (tool: Record<string, any>) => tools.push(tool),
  registerCommand: (_name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.push(spec.handler),
  registerShortcut: () => {},
  sendMessage: () => {},
  on: () => {},
} as never);
const workflowTool = tools.at(-1) as { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, any> }> };

const script = `export const meta = { name: "restart-demo", description: "read two files", phases: [{ title: "Read", agents: 2 }] };
phase("Read");
const [a, b] = await parallel([
  () => agent("Read a.txt and reply with one short sentence about it.", { label: "alpha", phase: "Read" }),
  () => agent("Read b.txt and reply with one short sentence about it.", { label: "beta", phase: "Read" }),
]);
return JSON.stringify({ a: a.ok, b: b.ok });`;

const run = await workflowTool.execute("e2e-p6", { script, name: "restart-demo", background: true }, new AbortController().signal, () => {}, ctx);
const jobId = String(run.details.job ?? "");
check("the run was launched as a background job", jobId.startsWith("wf_"), jobId);

/* --- reading the job back through the command --------------------------- */
const notices: string[] = [];
const ui = {
  ui: {
    notify: (text: string) => notices.push(text),
    setStatus: () => {},
    custom: ctx.ui.custom,
  },
};
const send = async (args: string): Promise<string> => {
  notices.length = 0;
  await commands[0]!(args, ui);
  return notices.join("\n");
};

// Wait for the run to settle, without guessing a sleep length.
let detail = "";
for (let attempt = 0; attempt < 200; attempt += 1) {
  detail = await send(jobId);
  if (/status: (running|queued|paused)/.test(detail) === false && detail.trim() !== "") break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
check("the background run finished", detail.includes(jobId) || detail.length > 0, detail.split("\n")[0]?.slice(0, 50) ?? "");
check("both agents ran", /alpha/.test(detail) && /beta/.test(detail));

/** The token number in the detail text, so the bill can be compared. */
const tokensOf = (text: string): number => {
  const match = /([\d.]+)(k?) tokens/.exec(text);
  if (!match) return 0;
  const value = Number(match[1]);
  return match[2] === "k" ? Math.round(value * 1000) : value;
};

/* --- 1. say no: nothing changes ---------------------------------------- */
const before = await send(jobId);
keyPlan.push(["\u001b"]);
const refused = await send(`restart ${jobId} alpha`);
check("closing the card without choosing restarts nothing", /not restarted|you said no/i.test(refused), refused.slice(0, 70));
const afterRefusal = await send(jobId);
check("the run is unchanged after a refusal", before === afterRefusal);
check("the card said it costs tokens again", (cards.at(-1) ?? "").includes("spends tokens again"));
check("the card started on the safe answer", (cards.at(-1) ?? "").includes("2. No"));

/* --- 2. say yes: one agent runs again ---------------------------------- */
keyPlan.push(["y"]);
const accepted = await send(`restart ${jobId} alpha`);
check("the restart ran", /again/i.test(accepted) && !/did not run/i.test(accepted), accepted.slice(0, 70));
const after = await send(jobId);
check("the tokens went up", tokensOf(after) > tokensOf(before), `${tokensOf(before)} -> ${tokensOf(after)}`);
check("a second card was shown for the second ask", cards.length >= 2);
check("the run still names both agents", /alpha/.test(after) && /beta/.test(after));

console.log("");
if (failures.length === 0) {
  console.log("ALL CHECKS PASSED");
  process.exit(0);
}
console.log(`FAILED: ${failures.length}`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(1);
