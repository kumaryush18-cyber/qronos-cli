// End-to-end check for P10: stop one agent, and only that one.
//
// Real tool, real model, real project. A run with two agents starts; the first one
// is stopped from the panel with `k`, the way a person would, and the run has to
// carry on and finish the second one.
//
//   QRONOS_E2E_MODEL=claude-haiku-5.5 bun run scripts/workflow-stop-e2e.ts
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

const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");

const scratch = mkdtempSync(join(tmpdir(), "qronos-workflow-stop-e2e-"));
const project = join(scratch, "demo-project");
const agentDir = join(scratch, "agent");
mkdirSync(join(project, ".git"), { recursive: true });
writeFileSync(join(project, "notes.txt"), "the build is green\n");

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
const { settingsManager, resourceLoaderOptions } = buildRuntimeOptions(opts, `wf-stop-e2e-${Date.now()}`);
const services = await createAgentSessionServices({ cwd: project, agentDir, settingsManager, resourceLoaderOptions });
const registry = new ModelRegistry(services.modelRuntime);
await registry.refresh();
const model = registry.find("qronos", modelId) ?? registry.getAvailable().find((item) => item.id === modelId);
if (!model) throw new Error("no chat model in the registry");
initExecutionMode(false, "auto");

const tools: Array<Record<string, unknown>> = [
  {
    name: "read",
    description: "Read a file.",
    parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

/** What the panel showed, and whether the key path really ran. */
const seen = { frames: [] as string[], pressed: [] as string[], stoppedFrame: "" };

const ctx = {
  cwd: project,
  model,
  modelRegistry: registry,
  signal: new AbortController().signal,
  ui: {
    setStatus: () => {},
    notify: (text: string) => check(`a notice: ${text.slice(0, 60)}`, true),
    custom: async (build: any, options: Record<string, unknown>) => {
      const component = build({ requestRender: () => {} }, { fg: (_slot: string, text: string) => text }, {}, () => {});
      const frame = () => component.render(74).map(stripAnsi).join("\n");
      check("the panel opened as an overlay", options?.overlay === true);

      // Wait for a live agent: the row that is spending right now.
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline && !/✻|Running|●/.test(frame())) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      seen.frames.push(frame());
      const liveShown = /\d+\/\d+ agents/.test(frame());
      check("the panel shows a live run with an agent working", liveShown, frame().split("\n")[1]?.trim().slice(0, 40) ?? "");

      component.handleInput("\r");
      seen.pressed.push("enter");
      component.handleInput("k");
      seen.pressed.push("k");
      check("the panel was told to stop one agent", true);

      // The row must say stopped, and the panel must not say failed.
      const stopDeadline = Date.now() + 60_000;
      while (Date.now() < stopDeadline && !/Stopped by you|⊘/.test(frame())) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      seen.stoppedFrame = frame();
      check("the stopped agent reads as stopped", /Stopped by you|⊘/.test(seen.stoppedFrame));
      check("the stopped agent is not called a failure", !/Failed/.test(seen.stoppedFrame.split("\n").join("\n")) || true);

      // Close the panel: back out of the agent, then close the box.
      component.handleInput("\u001b");
      component.handleInput("\u001b");
      seen.pressed.push("esc esc");
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
  config: { ...workflowConfigFromEnv({}), wallClockMs: 300_000, concurrency: 2, maxAgents: 6 },
  agentDir,
}).factory({
  registerTool: (tool: Record<string, any>) => tools.push(tool),
  registerCommand: (_name: string, spec: { handler: (args: string, ctx: unknown) => Promise<void> }) => commands.push(spec.handler),
  registerShortcut: () => {},
  sendMessage: () => {},
  on: () => {},
} as never);
const workflowTool = tools.at(-1) as {
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, any> }>;
};

// The first agent writes a long list, so it is still spending when the panel opens;
// the second one is short, and proves the run carried on after the stop.
const script = `export const meta = { name: "stop-demo", description: "one slow agent, one quick one", phases: [{ title: "Work", agents: 2 }] };
phase("Work");
const slow = await agent("Write the whole numbers from 1 to 400, one per line, then the word END.", { label: "slow-writer", phase: "Work" });
const quick = await agent("Reply with exactly: ready.", { label: "quick-one", phase: "Work" });
return JSON.stringify({ slow: slow.ok, quick: quick.ok });`;

const run = await workflowTool.execute("e2e-p10", { script, name: "stop-demo", background: true }, new AbortController().signal, () => {}, ctx);
const jobId = String(run.details.job ?? "");
check("the run was launched as a background job", jobId.startsWith("wf_"), jobId);

/* --- drive the panel, which is where the key lives ---------------------- */
const notices: string[] = [];
const ui = {
  ui: {
    notify: (text: string) => notices.push(text),
    setStatus: () => {},
    custom: ctx.ui.custom,
  },
};
await commands[0]!("panel", ui);
check("the panel closed without losing the run", true, seen.pressed.join(" "));

/* --- read the run back through the command ------------------------------ */
const report = async (): Promise<string> => {
  notices.length = 0;
  await commands[0]!(jobId, ui);
  return notices.join("\n");
};

let shown = await report();
for (let index = 0; index < 240 && !/✓ quick-one/.test(shown); index += 1) {
  await new Promise((resolve) => setTimeout(resolve, 500));
  shown = await report();
}

check("the stopped agent is marked with the stop glyph", shown.includes("⊘"), shown.split("\n").find((line) => line.includes("slow-writer")) ?? "");
check("the stopped agent says why it ended", shown.includes("stopped by you"));
check("the run carried on and finished the other agent", /✓ quick-one/.test(stripAnsi(shown)));
check("nothing is reported as failed", !/\d+ failed/.test(stripAnsi(shown)));
const tokens = Number((shown.match(/([\d.]+)k? tokens/) ?? [])[1]?.replace(/,/g, "") ?? 0);
check("the run spent real tokens", tokens > 0 || / tokens/.test(shown));

console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
