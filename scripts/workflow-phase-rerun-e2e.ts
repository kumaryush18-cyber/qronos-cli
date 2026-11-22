// End-to-end check for P11: run a whole phase again.
//
// Real tool, real model, real project. Two agents finish in one phase; the phase
// is rerun twice — "no" once (which must change nothing) and "yes" once (which
// must run both agents and raise the bill).
//
//   QRONOS_E2E_MODEL=claude-haiku-5.5 bun run scripts/workflow-phase-rerun-e2e.ts
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
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The header reads "2 agents · 12s · 3.4k tokens", so the unit is in the text. */
const tokensOf = (report: string): number => {
  const plain = stripAnsi(report);
  const match = plain.match(/([\d.,]+)(k?) tokens/);
  if (!match) return 0;
  const value = Number(match[1]!.replace(/,/g, ""));
  return Math.round(value * (match[2] === "k" ? 1_000 : 1));
};

const scratch = mkdtempSync(join(tmpdir(), "qronos-workflow-phase-e2e-"));
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
const { settingsManager, resourceLoaderOptions } = buildRuntimeOptions(opts, `wf-phase-e2e-${Date.now()}`);
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

/** What the user presses on each phase card, in the order they appear. */
const phaseAnswers: string[] = ["n", "n", "y"];
const cards: string[] = [];
const seen = { notices: [] as string[], panelOpened: 0, phaseAnswered: 0 };

const ctx = {
  cwd: project,
  model,
  modelRegistry: registry,
  signal: new AbortController().signal,
  ui: {
    setStatus: () => {},
    notify: (text: string) => seen.notices.push(text),
    custom: async (build: any, options: Record<string, unknown>) => {
      const component = build({ requestRender: () => {} }, { fg: (_slot: string, text: string) => text }, {}, () => {});
      const frame = () => component.render(74).map(stripAnsi).join("\n");
      const drawn = frame();

      // The start card: a workflow that would spend money asks first.
      if (drawn.includes("dynamic workflow")) {
        component.handleInput("\r");
        return undefined;
      }

      // The phase card: the one this test is about.
      if (drawn.includes("Run the phase")) {
        cards.push(drawn);
        seen.phaseAnswered += 1;
        const key = phaseAnswers.shift() ?? "n";
        const target = key === "y" ? drawn.split("\n").findIndex((line) => line.includes("Yes")) : -1;
        if (target >= 0) {
          // Move the cursor to Yes before pressing enter, the way a person would.
          for (let step = 0; step < 4; step += 1) component.handleInput("\u001b[A");
        }
        component.handleInput(key === "y" ? "\r" : key);
        if (component.finished !== true) component.handleInput("\u001b");
        return undefined;
      }

      // Otherwise it is the panel: press `a` and wait for the card it opens, then
      // close it. This proves the key reaches the same decision as the command.
      seen.panelOpened += 1;
      component.handleInput("a");
      for (let index = 0; index < 400 && seen.phaseAnswered === 0; index += 1) await sleep(25);
      component.handleInput("\u001b");
      component.handleInput("\u001b");
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
const workflowTool = tools.at(-1) as {
  execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, any> }>;
};

const script = `export const meta = { name: "phase-demo", description: "two agents in one phase", phases: [{ title: "Look", agents: 2 }] };
phase("Look");
const [a, b] = await parallel([
  () => agent("Read a.txt and reply with one short sentence about it.", { label: "alpha", phase: "Look" }),
  () => agent("Read b.txt and reply with one short sentence about it.", { label: "beta", phase: "Look" }),
]);
return JSON.stringify({ a: a.ok, b: b.ok });`;

const run = await workflowTool.execute("e2e-p11", { script, name: "phase-demo", background: true }, new AbortController().signal, () => {}, ctx);
const jobId = String(run.details.job ?? "");
check("the run was launched as a background job", jobId.startsWith("wf_"), jobId);

const ui = {
  ui: {
    notify: (text: string) => seen.notices.push(text),
    setStatus: () => {},
    custom: ctx.ui.custom,
  },
};

const report = async (): Promise<string> => {
  seen.notices.length = 0;
  await commands[0]!(jobId, ui);
  return seen.notices.join("\n");
};

let shown = await report();
for (let index = 0; index < 240 && !/✓ alpha/.test(stripAnsi(shown)); index += 1) {
  await sleep(500);
  shown = await report();
}
check("both agents finished the first time", /✓ alpha/.test(stripAnsi(shown)) && /✓ beta/.test(stripAnsi(shown)));
const tokensBefore = tokensOf(shown);
check("the first run spent real tokens", tokensBefore > 0, `${tokensBefore} tokens`);

/* --- the panel key, answered no: nothing may change ---------------------- */
await commands[0]!("panel", ui);
const afterPanelNo = await report();
check("the panel opened and asked about the phase", seen.panelOpened > 0);
check("the card was shown from the panel key", cards.length >= 1);
check("saying no spent nothing", tokensOf(afterPanelNo) === tokensBefore, `${tokensBefore} → ${tokensOf(afterPanelNo)}`);
check("the card names the phase", cards[0]?.includes("Look") === true);
check("the card says how many and what it costs", /2 agents/.test(cards[0] ?? "") && /tokens/.test(cards[0] ?? ""));

/* --- the command, answered no, then yes ---------------------------------- */
seen.notices.length = 0;
await commands[0]!("rerun " + jobId + " Look", ui);
check("the command asked the same card", cards.length >= 2);
let notice = seen.notices.join("\n");
check("declining says so, and nothing ran", /said no/.test(notice), notice.split("\n")[0]?.slice(0, 60) ?? "");

seen.notices.length = 0;
await commands[0]!("rerun " + jobId + " Look", ui);
notice = seen.notices.join("\n");
for (let index = 0; index < 200 && !/ran 2 of 2 again/.test(notice); index += 1) {
  await sleep(500);
  notice = seen.notices.join("\n");
}
check("the rerun said how many ran", /ran 2 of 2 again/.test(notice), notice.split("\n")[0]?.slice(0, 70) ?? "");

shown = await report();
const tokensAfter = tokensOf(shown);
check("both agents ran again", /ran again|attempt 2/.test(stripAnsi(shown)));
check("the bill went up", tokensAfter > tokensBefore, `${tokensBefore} → ${tokensAfter}`);
check("both agents are still there", /alpha/.test(stripAnsi(shown)) && /beta/.test(stripAnsi(shown)));
check("nothing is reported as failed", !/\d+ failed/.test(stripAnsi(shown)));
check("the rerun was one at a time", cards.length === 3, `${cards.length} cards`);

console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
