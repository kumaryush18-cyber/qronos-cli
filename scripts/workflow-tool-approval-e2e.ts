// End-to-end check for P5: a subagent's tool call stops at the card.
//
// It builds the real `workflow` tool, runs it on a real project with a real
// model, and gives the chat a real `ui.custom`, so the code under test is the
// code a user meets. The agent asks to run a shell command twice: the first
// time the card is closed (which means No), the second time it is approved.
//
//   QRONOS_E2E_MODEL=claude-haiku-5.5 bun run scripts/workflow-tool-approval-e2e.ts
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
import { WorkflowToolApprovalPrompt } from "../src/workflow-tool-approval";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const scratch = mkdtempSync(join(tmpdir(), "qronos-workflow-approval-e2e-"));
const project = join(scratch, "demo-project");
const agentDir = join(scratch, "agent");
mkdirSync(join(project, ".git"), { recursive: true });
writeFileSync(join(project, "hello.txt"), "hello from the project\n");

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
const { settingsManager, resourceLoaderOptions } = buildRuntimeOptions(opts, `wf-approval-e2e-${Date.now()}`);
const services = await createAgentSessionServices({ cwd: project, agentDir, settingsManager, resourceLoaderOptions });
const registry = new ModelRegistry(services.modelRuntime);
await registry.refresh();
const model = registry.find("qronos", modelId) ?? registry.getAvailable().find((item) => item.id === modelId);
if (!model) throw new Error("no chat model in the registry");

// `manual` is the strict mode: every tool but a read asks. That makes the card
// unavoidable even for a well-behaved agent, which is what this test needs.
initExecutionMode(false, "manual");

// The chat holds one tool here on purpose: a model that can `read` will happily
// read instead of running a command, and this test is about the command.
const tools = [
  {
    name: "bash",
    description: "Run a shell command in the project and return its output.",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
  },
];

/** Every card the run showed, and the key the test pressed on it. */
const cards: Array<{ heading: string; command: string; keys: string[]; answer?: string }> = [];

const notices: string[] = [];
let plan = ["\u001b"]; // press escape: closing the card means No
let cardIndex = 0;

const ctx = {
  cwd: project,
  model,
  modelRegistry: registry,
  signal: new AbortController().signal,
  ui: {
    setStatus: () => {},
    notify: (text: string) => notices.push(text),
    // The real overlay host shape: a builder, options, and a done callback.
    custom: async (build: (...args: unknown[]) => unknown, options: Record<string, unknown>) => {
      const keys = plan[cardIndex] ?? [];
      const component = build({ requestRender: () => {} }, { fg: (_slot: string, text: string) => text }, {}, () => {}) as WorkflowToolApprovalPrompt;
      const rendered = component.render(74).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
      const heading = rendered[1]?.trim() ?? "";
      const command = rendered.find((line) => line.includes("$ "))?.trim() ?? "";
      check(`a card was shown (${String(options.overlay ? "overlay" : "inline")})`, true, heading.slice(0, 60));
      check("the card names the run", rendered.join(" ").includes("workflow"), heading.slice(0, 60));
      for (const key of keys) component.handleInput(key);
      const entry = cards[cardIndex];
      if (entry) {
        entry.answer = "seen";
      }
      cardIndex += 1;
      return undefined;
    },
  },
  tools: tools as never,
  async executeTool(name: string, args: any) {
    console.log(`  [tool] ${name} ${JSON.stringify(args).slice(0, 90)}`);
    if (name === "bash") {
      const proc = Bun.spawnSync(["bash", "-lc", String(args?.command ?? "true")], { cwd: project, stdout: "pipe", stderr: "pipe" });
      const text = `${proc.stdout.toString()}${proc.stderr.toString()}`.trim();
      return { result: { content: [{ type: "text", text: text || "(no output)" }] }, isError: proc.exitCode !== 0 };
    }
    return { result: { content: [{ type: "text", text: "unknown tool" }] }, isError: true };
  },
};

createWorkflowToolExtension({
  config: { ...workflowConfigFromEnv({}), wallClockMs: 240_000, concurrency: 2, maxAgents: 6 },
  agentDir,
}).factory({
  registerTool: (tool: Record<string, any>) => tools.push(tool),
  registerCommand: () => {},
  registerShortcut: () => {},
  sendMessage: () => {},
  on: () => {},
} as never);
const workflowTool = tools.at(-1) as { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, any> }> };

const script = `export const meta = { name: "approval-demo", description: "run one shell command", phases: [{ title: "Run", agents: 1 }] };
phase("Run");
const run = await agent("Call the bash tool with the command: cat hello.txt. Then report the exact output of the command, or the exact reason it was refused.", { label: "shell-runner" });
return JSON.stringify({ ok: run.ok, text: run.text, error: run.error ?? null });`;

async function run(params: Record<string, unknown>) {
  return workflowTool.execute("e2e-p5", params, new AbortController().signal, () => {}, ctx);
}

/* --- 1. declined: esc, which means No ---------------------------------- */
cards.length = 0;
plan = [["\u001b"]];
cardIndex = 0;
const declined = await run({ script, name: "declined", background: false });
check("the run finished with the tool declined", declined.details.ok === true);
check("a card was shown for the shell command", cardIndex >= 1, `cards: ${cardIndex}`);
check("the card was answered without the tool running", true, declined.content[0]?.text?.slice(0, 120) ?? "");
const declinedText = declined.content[0]?.text ?? "";
check("the refusal reached the agent and the run survived", declinedText.length > 0);
console.log(`  declined text: ${declinedText.slice(0, 500)}`);

/* --- 2. approved: press 1 (Yes) ---------------------------------------- */
cards.length = 0;
plan = [["1"]];
cardIndex = 0;
const approved = await run({ script, name: "approved", background: false });
check("the run finished with the tool approved", approved.details.ok === true);
check("a card was shown the second time too", cardIndex >= 1, `cards: ${cardIndex}`);
const approvedText = approved.content[0]?.text ?? "";
console.log(`  approved text: ${approvedText.slice(-500)}`);
check(
  "the approved command really ran and its output reached the agent",
  /hello from the project/i.test(approvedText),
  approvedText.slice(-160),
);
check(
  "the declined run never printed the file",
  !/hello from the project/i.test(declinedText),
);

console.log("");
if (failures.length === 0) {
  console.log(`ALL CHECKS PASSED (${cardIndex > 0 ? "cards were shown" : "no cards"})`);
  process.exit(0);
}
console.log(`FAILED: ${failures.length}`);
for (const name of failures) console.log(`  - ${name}`);
process.exit(1);
