// End-to-end check for P9: a saved script comes back to life.
//
// Real tool, real model, real project, real files. A script is written where `s`
// would write it, then found, listed, run and edited through `/workflows`, with
// the approval card answered for real.
//
//   QRONOS_E2E_MODEL=claude-haiku-5.5 bun run scripts/workflow-scripts-e2e.ts
//
// Exit code is 0 only when every check passed.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

const scratch = mkdtempSync(join(tmpdir(), "qronos-workflow-scripts-e2e-"));
const project = join(scratch, "demo-project");
const agentDir = join(scratch, "agent");
const scriptDir = join(project, ".qronos", "workflows");
mkdirSync(scriptDir, { recursive: true });
mkdirSync(join(project, ".git"), { recursive: true });
writeFileSync(join(project, "a.txt"), "alpha\n");
writeFileSync(join(project, "b.txt"), "beta\n");
// The commands find saved scripts from the working directory, which is the one
// thing a user's shell gives them for free and a script has to say out loud.
process.chdir(project);

const SCRIPT = `export const meta = { name: "two-looks", description: "read two files", phases: [{ title: "Read", agents: 2 }] };
phase("Read");
const [a, b] = await parallel([
  () => agent("Read a.txt and reply with one short sentence about it.", { label: "alpha", phase: "Read" }),
  () => agent("Read b.txt and reply with one short sentence about it.", { label: "beta", phase: "Read" }),
]);
return JSON.stringify({ a: a.ok, b: b.ok });`;
const scriptFile = join(scriptDir, "two-looks.js");
writeFileSync(scriptFile, SCRIPT, "utf8");

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
const { settingsManager, resourceLoaderOptions } = buildRuntimeOptions(opts, `wf-scripts-e2e-${Date.now()}`);
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

/** The keys pressed on each card, in order. */
const keyPlan: string[][] = [];
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
      const { readFileSync: readFile } = await import("node:fs");
      return {
        result: { content: [{ type: "text", text: readFile(join(project, String(args?.path ?? "")), "utf8") }] },
        isError: false,
      };
    }
    return { result: { content: [{ type: "text", text: "unknown tool" }] }, isError: true };
  },
};

const commands: Array<(args: string, ctx: unknown) => Promise<void>> = [];
const extension = createWorkflowToolExtension({
  config: { ...workflowConfigFromEnv({}), wallClockMs: 240_000, concurrency: 2, maxAgents: 6 },
  agentDir,
}) as unknown as { factory: (api: unknown) => void };
/** What the command asks the model to do; the fake model does exactly that. */
const asked: string[] = [];
extension.factory({
  registerTool: (tool: Record<string, any>) => tools.push(tool),
  registerCommand: (_name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.push(spec.handler),
  registerShortcut: () => {},
  sendMessage: () => {},
  sendUserMessage: (text: string) => asked.push(text),
  on: () => {},
} as never);
const workflowTool = tools.at(-1) as { execute: (...args: unknown[]) => Promise<{ details: Record<string, any> }> };

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

/* --- 1. the list ------------------------------------------------------- */
const listed = await send("scripts");
check("the saved script is listed", listed.includes("two-looks"), listed.split("\n")[2]?.trim() ?? "");
check("the list says how to run one", listed.includes("/workflows run <name>"));

/* --- 2. a name that is not there --------------------------------------- */
const missing = await send("run deploy-please");
check("an unknown name lists what exists", /No saved script called/.test(missing) && /two-looks/.test(missing), missing.split("\n")[0] ?? "");

/* --- 3. run it for real ------------------------------------------------ */
// A command cannot run tools, so it asks the model. Here the "model" is this
// script: it does exactly what the message says, which is call the tool with the
// file path.
keyPlan.push(["\r"]);
const launched = await send("run two-looks");
check("the command asked the model to run the saved file", asked.length === 1 && asked[0]!.includes(scriptFile), asked[0]?.slice(0, 60) ?? "");
check("the command said nothing runs before the card", launched.includes("nothing runs until you answer it"), launched.split("\n")[0] ?? "");
const toolRun = await workflowTool.execute("e2e-run", { scriptFile }, new AbortController().signal, () => {}, ctx);
const jobId = String(toolRun.details.job ?? "");
check("the tool read the file and launched a real job", jobId.startsWith("wf_"), jobId);
check("the card named the script before it ran", (cards[0] ?? "").includes("two-looks"));
check("the run took its name from the file", toolRun.details.name === "two-looks", String(toolRun.details.name));

let detail = "";
for (let attempt = 0; attempt < 240; attempt += 1) {
  detail = await send(jobId);
  if (/status: (running|queued|paused)/.test(detail) === false && detail.trim() !== "") break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
check("the run finished", /finished|failed/.test(detail), detail.split("\n")[0]?.slice(0, 50) ?? "");
check("both agents in the saved script ran", /alpha/.test(detail) && /beta/.test(detail));
check("the run really cost tokens", /[1-9][\d.]*k? tokens/.test(detail), detail.split("\n")[1] ?? "");

/* --- 4. edit it, and say no -------------------------------------------- */
// A fake editor that appends one line, so the change is real but harmless.
const editorDir = mkdtempSync(join(tmpdir(), "qronos-editor-e2e-"));
const editor = join(editorDir, "editor.sh");
writeFileSync(editor, `#!/bin/sh\nprintf '// edited by the e2e\\n' >> "$1"\n`, "utf8");
chmodSync(editor, 0o755);
const savedEditor = process.env.EDITOR;
process.env.EDITOR = editor;

keyPlan.push(["\u001b"]);
await send("edit two-looks");
check("declining the save card leaves the file exactly as it was", readFileSync(scriptFile, "utf8") === SCRIPT);

/* --- 5. edit it, and say yes ------------------------------------------ */
keyPlan.push(["y"]);
const saved = await send("edit two-looks");
check("accepting the save card writes the file", saved.includes("Saved"), saved.split("\n")[0] ?? "");
const afterSave = readFileSync(scriptFile, "utf8");
check("the change is really on disk", afterSave.includes("edited by the e2e"), afterSave.split("\n").at(-2) ?? "");
check("the script itself survived the edit", afterSave.includes("agent(\"Read a.txt"));

if (savedEditor === undefined) delete process.env.EDITOR;
else process.env.EDITOR = savedEditor;

console.log("");
if (failures.length === 0) {
  console.log("ALL CHECKS PASSED");
  process.exit(0);
}
console.log(`FAILED: ${failures.length}`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(1);
