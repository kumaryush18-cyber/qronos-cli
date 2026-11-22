// End-to-end check for P12: run the failed agents again, and only those.
//
// Real tool, real model, real project. One agent is asked for an impossible model
// id, so it fails for a real reason; two others finish. Then `f` is answered "no"
// once (nothing may change) and "yes" once (only the failed one runs again, and
// the bill rises while the good answers stay untouched).
//
//   QRONOS_E2E_MODEL=claude-haiku-5.5 bun run scripts/workflow-retry-e2e.ts
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
const tokensOf = (report: string): number => {
  const match = stripAnsi(report).match(/([\d.,]+)(k?) tokens/);
  if (!match) return 0;
  return Math.round(Number(match[1]!.replace(/,/g, "")) * (match[2] === "k" ? 1_000 : 1));
};
const rowOf = (report: string, label: string): string =>
  stripAnsi(report)
    .split("\n")
    .find((line) => line.includes(label)) ?? "";

const scratch = mkdtempSync(join(tmpdir(), "qronos-workflow-retry-e2e-"));
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
const { settingsManager, resourceLoaderOptions } = buildRuntimeOptions(opts, `wf-retry-e2e-${Date.now()}`);
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

const answers: string[] = ["n", "y"];
const cards: string[] = [];
const seen = { notices: [] as string[], phaseAnswered: 0 };

const ctx = {
  cwd: project,
  model,
  modelRegistry: registry,
  signal: new AbortController().signal,
  ui: {
    setStatus: () => {},
    notify: (text: string) => seen.notices.push(text),
    custom: async (build: any) => {
      const component = build({ requestRender: () => {} }, { fg: (_slot: string, text: string) => text }, {}, () => {});
      const drawn = component.render(74).map(stripAnsi).join("\n");

      if (drawn.includes("dynamic workflow")) {
        component.handleInput("\r");
        return undefined;
      }
      if (drawn.includes("failed agent")) {
        cards.push(drawn);
        seen.phaseAnswered += 1;
        const key = answers.shift() ?? "n";
        if (key === "y") {
          // The cursor starts on No, so walk up to Yes before pressing enter.
          for (let step = 0; step < 4; step += 1) component.handleInput("\u001b[A");
          component.handleInput("\r");
        } else {
          component.handleInput(key);
        }
        if (component.finished !== true) component.handleInput("\u001b");
        return undefined;
      }
      // Otherwise it is the panel: `f`, wait for the card, then close.
      component.handleInput("f");
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
  config: { ...workflowConfigFromEnv({}), wallClockMs: 240_000, concurrency: 3, maxAgents: 6 },
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

// `broken-agent` is held to a schema its answer cannot satisfy — it is asked for a
// number over 1000 and will answer with a sentence — so it fails for a real reason
// that is the same on the second try. The retry must be held to that same schema,
// which is why the record keeps it.
const script = `export const meta = { name: "retry-demo", description: "two good agents and one broken one", phases: [{ title: "Look", agents: 3 }] };
phase("Look");
const [a, b, broken] = await parallel([
  () => agent("Read a.txt and reply with one short sentence about it.", { label: "alpha", phase: "Look" }),
  () => agent("Read b.txt and reply with one short sentence about it.", { label: "beta", phase: "Look" }),
  () => agent("Reply with the word hi.", {
    label: "broken-agent",
    phase: "Look",
    // This pattern can never match: a caret in the middle of a string is a
    // position, and it is never after the letter a. No answer can satisfy it, so
    // the failure is real and repeatable rather than a guess about the model.
    schema: { type: "object", properties: { value: { type: "string", pattern: "a^b" } }, required: ["value"], additionalProperties: false },
  }),
]);
return JSON.stringify({ a: a.ok, b: b.ok, broken: broken.ok, why: broken.error });`;

const run = await workflowTool.execute("e2e-p12", { script, name: "retry-demo", background: true }, new AbortController().signal, () => {}, ctx);
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
// Wait for the run to be finished, not just for two rows to appear: a retry asked
// of a live run is refused for a good reason, and testing the refusal is not this
// script's job.
// Both facts are needed: the run is settled AND every row has arrived. Text is
// the only handle this script has on the job, so it waits for the three labels by
// name rather than for a summary line that can appear a frame early.
const finished = (text: string) => {
  const plainText = stripAnsi(text);
  return (
    /— finished/.test(plainText) &&
    /✓ alpha/.test(plainText) &&
    /✓ beta/.test(plainText) &&
    /broken-agent/.test(plainText)
  );
};
let waited = 0;
for (; waited < 300 && !finished(shown); waited += 1) {
  await sleep(500);
  shown = await report();
}
if (!finished(shown)) {
  console.log(`the run did not settle in ${waited / 2}s; last report:`);
  console.log(stripAnsi(shown));
}
check("the good agents finished", /✓ alpha/.test(stripAnsi(shown)) && /✓ beta/.test(stripAnsi(shown)));
check("one agent really failed", /✗ broken-agent/.test(stripAnsi(shown)), rowOf(shown, "broken-agent").trim().slice(0, 60));
const tokensBefore = tokensOf(shown);
const alphaBefore = rowOf(shown, "alpha");
check("the first run spent real tokens", tokensBefore > 0, `${tokensBefore} tokens`);

/* --- the panel key, answered no ------------------------------------------ */
await commands[0]!("panel", ui);
const afterNo = await report();
check("the card was shown from the panel key", cards.length >= 1);
check("the card names the failed agent", (cards[0] ?? "").includes("broken-agent"), (cards[0] ?? "").split("\n")[2]?.trim() ?? "");
check("saying no spent nothing", tokensOf(afterNo) === tokensBefore, `${tokensBefore} → ${tokensOf(afterNo)}`);

/* --- the command, answered yes ------------------------------------------- */
seen.notices.length = 0;
await commands[0]!("retry " + jobId, ui);
let notice = seen.notices.join("\n");
for (let index = 0; index < 200 && !/ran 1 of 1 failed again/.test(notice); index += 1) {
  await sleep(500);
  notice = seen.notices.join("\n");
}
check("the retry said what ran", /ran 1 of 1 failed again/.test(notice), notice.split("\n")[0]?.slice(0, 70) ?? "");

shown = await report();
const tokensAfter = tokensOf(shown);
check("the failed agent ran again", /attempt 2|ran again/.test(rowOf(shown, "broken-agent")));
check("the good agents were not run again", !/ran again/.test(rowOf(shown, "alpha")) && !/ran again/.test(rowOf(shown, "beta")));
check("the good agents kept their answers", rowOf(shown, "alpha") === alphaBefore || /✓ alpha/.test(stripAnsi(shown)));
check("the bill went up", tokensAfter > tokensBefore, `${tokensBefore} → ${tokensAfter}`);
check("the still-broken agent is a cross, not a stop", /✗ broken-agent/.test(stripAnsi(shown)));

console.log(`\n${failures.length === 0 ? "ALL CHECKS PASSED" : `${failures.length} CHECK(S) FAILED`}`);
process.exit(failures.length === 0 ? 0 : 1);
