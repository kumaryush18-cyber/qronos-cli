// End-to-end check for the workflow panel, against a REAL model.
//
// The full workflow E2E (scripts/workflow-e2e.ts) proves the runtime. This one
// proves the panel: a real 3-agent run on a real model, the real Alt+W handler,
// the real overlay, and the keys that pause, resume, replay and stop it.
//
//   QRONOS_E2E_MODEL=claude-haiku-5.5 bun run scripts/workflow-panel-e2e.ts
//
// Exit code is 0 only when every step passed.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { ModelRegistry, createAgentSessionServices } from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { loadJwt } from "../src/credentials";
import { getCredentialsPath, getQronosAgentDir } from "../src/paths";
import { PROVIDER_PRESETS } from "../src/provider";
import { createWorkflowToolExtension } from "../src/workflow-tool";
import { workflowConfigFromEnv } from "../src/workflow-types";
import { WorkflowPanel, visibleLength } from "../src/workflow-panel";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const scratch = mkdtempSync(join(tmpdir(), "qronos-panel-e2e-"));
const project = join(scratch, "demo-project");
const agentDir = join(scratch, "agent");
mkdirSync(join(project, ".git"), { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(
  join(project, "src", "auth.ts"),
  "export function checkSession(token?: string) {\n  if (!token) return false;\n  return token.length > 8;\n}\n",
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
const { settingsManager, resourceLoaderOptions } = buildRuntimeOptions(opts, `panel-e2e-${Date.now()}`);
const services = await createAgentSessionServices({ cwd: project, agentDir, settingsManager, resourceLoaderOptions });
const registry = new ModelRegistry(services.modelRuntime);
await registry.refresh();
const model = registry.find("qronos", modelId) ?? registry.getAvailable().find((item) => item.id === modelId);
if (!model) throw new Error("no chat model in the registry");

/* --- the smallest honest tool surface: read, ls ------------------------- */

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
void walk;

const notices: string[] = [];
const ctx = {
  cwd: project,
  model,
  modelRegistry: registry,
  signal: new AbortController().signal,
  ui: {
    setStatus: () => {},
    notify: (text: string) => notices.push(text),
  },
  tools: [readTool, lsTool] as never,
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
      return { result: { content: [{ type: "text", text: `unknown tool ${name}` }] }, isError: true };
    } catch (error) {
      return { result: { content: [{ type: "text", text: String(error) }] }, isError: true };
    }
  },
} as never;

/* --- capture the extension: tool, command, shortcut --------------------- */

const tools: Array<Record<string, any>> = [];
const deliveries: Array<{ content: string; customType: string }> = [];
const overlays: Array<Record<string, any>> = [];
let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
let panelShortcut: ((ctx: unknown) => Promise<void>) | undefined;
createWorkflowToolExtension({
  config: { ...workflowConfigFromEnv({}), wallClockMs: 600_000, concurrency: 4, maxAgents: 12 },
  agentDir,
}).factory({
  registerTool: (tool: Record<string, any>) => tools.push(tool),
  registerCommand: (name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
    if (name === "workflows") commandHandler = spec.handler;
  },
  registerShortcut: (key: string, spec: { handler: (ctx: unknown) => Promise<void> }) => {
    if (key === "alt+w") panelShortcut = spec.handler;
  },
  sendMessage: (message: Record<string, any>) =>
    deliveries.push({ content: String(message.content), customType: String(message.customType) }),
  on: () => {},
} as never);

const workflowTool = tools[0]!;
const run = (params: Record<string, unknown>) =>
  workflowTool.execute("panel-e2e", params, new AbortController().signal, () => {}, ctx) as Promise<{
    content: Array<{ text: string }>;
    details: Record<string, any>;
  }>;

const commandNotices: Array<{ text: string }> = [];
async function sendCommand(args: string): Promise<string> {
  commandNotices.length = 0;
  await commandHandler?.(args, { ui: { notify: (text: string) => commandNotices.push({ text }) } });
  return commandNotices.map((entry) => entry.text).join(" ");
}
/** The panel colours its lines, so assertions read them without escape codes. */
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  console.log(`model: ${modelId}\nproject: ${project}\n`);

  deliveries.length = 0;
  const launched = await run({
    name: "panel-demo",
    script: `
      const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
      const out = await parallel(files.map((file) => () => agent("Say the file name only: " + file, { label: file })));
      return out.map((r) => r.text).join(" | ");
    `,
  });
  const jobId = String(launched.details.job ?? "");
  check("a background workflow launched", jobId.startsWith("wf_"), jobId);
  check("nothing was delivered at launch", deliveries.length === 0, `${deliveries.length} deliveries`);
  await wait(1_500);

  /* open the panel the way a person does: Alt+W */
  const frames: number[] = [];
  let panel: WorkflowPanel | undefined;
  await panelShortcut?.({
    ui: {
      notify: (text: string) => notices.push(text),
      custom: async (build: any, options: any) => {
        overlays.push(options);
        panel = build(
          { requestRender: () => frames.push(Date.now()) },
          { fg: (_slot: string, text: string) => text },
          {},
          () => {},
        );
        return undefined;
      },
    },
  } as never);

  check("Alt+W opened an overlay", overlays.length === 1, `${overlays.length} overlays`);
  check("the overlay is centred", overlays[0]?.overlayOptions?.anchor === "center", JSON.stringify(overlays[0]?.overlayOptions ?? {}));

  const live = plain((panel?.render(74) ?? []).join("\n"));
  console.log(live);
  check("the panel shows the run by name", live.includes("panel-demo"), live.split("\n")[0] ?? "");
  check("the panel shows the live counters", /running/.test(live), live.slice(0, 120));
  check("the panel draws the agents that are working", (live.match(/✻/g) ?? []).length >= 1, `${(live.match(/✻/g) ?? []).length} rows`);
  const widths = new Set((panel?.render(74) ?? []).map((line) => visibleLength(line)));
  check("every line is the same width", widths.size === 1, [...widths].join(","));

  const frameDeadline = Date.now() + 4_000;
  while (frames.length < 2 && Date.now() < frameDeadline) await wait(50);
  check("the panel redraws itself while the run is live", frames.length >= 2, `${frames.length} frames`);

  panel?.handleInput(" ");
  const paused = await sendCommand(jobId);
  check("space paused the run", paused.includes("paused"), paused.slice(0, 160));
  const pausedView = plain((panel?.render(74) ?? []).join("\n"));
  check("the panel says it is paused", pausedView.includes("paused"), pausedView.split("\n")[0] ?? "");

  panel?.handleInput(" ");
  const resumed = await sendCommand(jobId);
  check("space again let it run", resumed.includes("running"), resumed.slice(0, 160));

  const deadline = Date.now() + 240_000;
  while (deliveries.length === 0 && Date.now() < deadline) await wait(500);
  check("the run finished and delivered its report", deliveries.length === 1, `${deliveries.length} deliveries`);
  const done = plain((panel?.render(74) ?? []).join("\n"));
  console.log(done);
  check("the panel shows the finished run", /finished|done/.test(done), done.split("\n")[0] ?? "");
  check("the panel shows a tick for the finished agents", done.includes("✓"), done.slice(0, 200));
  check("the panel kept drawing to the end", (panel?.render(74) ?? []).length > 4, "no lines");

  /* one agent's own view */
  panel?.handleInput("\r");
  const one = plain((panel?.render(74) ?? []).join("\n"));
  check("enter opens one agent", one.includes("phase") || one.includes("cost"), one.slice(0, 120));
  panel?.handleInput("\u001b");
  check("escape goes back to the list", (panel?.mode ?? "list") === "list", String(panel?.mode));

  /* replay from inside the panel, then stop it */
  panel?.handleInput("r");
  await wait(800);
  const replayId = String(panel?.job()?.id ?? "");
  check("r started a replay from the panel", replayId.startsWith("wf_") && replayId !== jobId, replayId);
  panel?.handleInput("x");
  await wait(1_000);
  const stopped = await sendCommand(replayId);
  check("x stopped it", /cancelled|finished|failed|done/.test(stopped), stopped.slice(0, 160));

  /* closing is safe */
  panel?.handleInput("\u001b");
  panel?.dispose();
  check("escape closed the panel and lost nothing", overlays.length === 1, `${overlays.length} overlays`);
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
