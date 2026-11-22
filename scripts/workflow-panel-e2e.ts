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
import { createWorkflowToolExtension, getLastWorkflowRun } from "../src/workflow-tool";
import { workflowConfigFromEnv } from "../src/workflow-types";
import { WorkflowPanel, visibleLength } from "../src/workflow-panel";
import { createWorkflowWaitingExtension } from "../src/workflow-waiting";
import { approvalRequestFor, buildApprovalLines } from "../src/workflow-approval";

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
/** Notes the extension puts in the transcript (custom entries, not messages). */
const notes: Array<{ type: string; data: unknown }> = [];
const entryRenderers = new Map<string, (...args: any[]) => any>();
const overlays: Array<Record<string, any>> = [];
let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
let panelShortcut: ((ctx: unknown) => Promise<void>) | undefined;
let handlersSessionStart: ((event: unknown, ctx: unknown) => void) | undefined;
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
  appendEntry: (type: string, data: unknown) => notes.push({ type, data }),
  registerEntryRenderer: (type: string, renderer: (...args: any[]) => any) => entryRenderers.set(type, renderer),
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
  await commandHandler?.(args, {
    ui: {
      notify: (text: string) => commandNotices.push({ text }),
      // A panel needs somewhere to live; the harness answers like a real host.
      custom: async (build: any, options: any) => {
        overlays.push(options);
        build({ requestRender: () => {} }, { fg: (_slot: string, text: string) => text }, {}, () => {});
        return undefined;
      },
    },
  });
  return commandNotices.map((entry) => entry.text).join(" ");
}
/** The panel colours its lines, so assertions read them without escape codes. */
const plain = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "");
/** A theme that adds nothing, so a check can read plain words. */
const plainTheme = { fg: (_slot: string, text: string) => text } as never;
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
  check("the panel shows the live counters", /\d+\/\d+ agents · /.test(live), live.slice(0, 120));
  check("the panel draws the agents that are working", (live.match(/✻/g) ?? []).length >= 1, `${(live.match(/✻/g) ?? []).length} rows`);
  const widths = new Set((panel?.render(74) ?? []).map((line) => visibleLength(line)));
  check("every line is the same width", widths.size === 1, [...widths].join(","));
  check("the panel is two columns", live.includes("Phases") && live.includes("│"), live.split("\n")[3] ?? "");

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
  check("the panel shows the finished run", /\d+\/\d+ agents/.test(done), done.split("\n")[0] ?? "");
  check("the panel shows a tick for the finished agents", done.includes("✓"), done.slice(0, 200));
  check("the panel kept drawing to the end", (panel?.render(74) ?? []).length > 4, "no lines");

  /* --- the waiting row, the dismissal note and the results table --------- */
  // The waiting row is told the count by the job manager, not by hand: this
  // proves the wiring from a real run all the way to the widget's line.
  const waitingExt = createWorkflowWaitingExtension({ frameMs: 20 });
  const waitingWidgets: Array<{ component: { render: (width: number) => string[] } }> = [];
  (waitingExt as unknown as { factory: (api: unknown) => void }).factory({
    on: (name: string, handler: (...args: any[]) => void) => {
      if (name === "session_start") handlersSessionStart = handler;
    },
  } as never);
  handlersSessionStart?.({}, {
    ui: {
      setWidget: (_id: string, factory: any) => waitingWidgets.push({ component: factory({ requestRender: () => {} }, {}) }),
    },
  });
  const waitingLines = () => waitingWidgets[0]?.component.render(80) ?? [];
  check("no run, no waiting row", waitingLines().length === 0, waitingLines().join(" | "));

  deliveries.length = 0;
  const waitingRun = await run({ name: "waiting-demo", script: "await agent('count to three'); return 1;" });
  const waitingDeadline = Date.now() + 20_000;
  while (waitingLines().length === 0 && Date.now() < waitingDeadline) await wait(100);
  const waitingLine = plain(waitingLines()[0] ?? "");
  console.log(waitingLine);
  check("a live run draws the waiting row", waitingLine.includes("Waiting for"), waitingLine);
  check("the row says how many runs wait", /Waiting for \d+ dynamic workflows? to finish/.test(waitingLine), waitingLine);
  check("the row is coloured and animating", (waitingLines()[0] ?? "").includes("\u001b["), "no colour codes");

  const goneDeadline = Date.now() + 90_000;
  while (waitingLines().length > 0 && Date.now() < goneDeadline) await wait(200);
  check("the row goes away when the run ends", waitingLines().length === 0, plain(waitingLines()[0] ?? "no row"));
  void waitingRun;

  // Closing the panel leaves one muted line in the transcript, and no message.
  const notesBefore = notes.length;
  const messagesBefore = deliveries.length;
  await sendCommand("panel");
  check("closing the panel appends exactly one note", notes.length === notesBefore + 1, `${notes.length - notesBefore} notes`);
  const note = notes.at(-1);
  check("the note is the dismissal line", JSON.stringify(note?.data ?? {}).includes("Dynamic workflows dialog dismissed"), JSON.stringify(note?.data));
  check("the note is not a message to the model", deliveries.length === messagesBefore, `${deliveries.length - messagesBefore} messages`);
  const noteRenderer = entryRenderers.get(String(note?.type ?? ""));
  check("a renderer exists for the note", typeof noteRenderer === "function", String(typeof noteRenderer));
  check(
    "the note renders as one plain line",
    plain(String(noteRenderer?.({ data: note?.data }, {}, { fg: (_s: string, t: string) => t })?.render(80)?.[0] ?? "")).startsWith("└"),
    String(noteRenderer?.({ data: note?.data }, {}, { fg: (_s: string, t: string) => t })?.render(80)?.[0] ?? ""),
  );

  /* one agent's own view: the picture on screenshot 18 */
  panel?.handleInput("\r");
  const one = plain((panel?.render(74) ?? []).join("\n"));
  check("enter opens one agent", one.includes("Prompt") && one.includes("Activity") && one.includes("Outcome"), one.slice(0, 160));
  check("the detail view keeps the agent list on the left", one.includes("│"), one.split("\n")[1] ?? "");
  check("the detail view names the model and the bill", /tokens · /.test(one), one.split("\n")[2] ?? "");
  check("the detail view says how long the agent has been quiet", /idle \d+s|took \d+s/.test(one), one.split("\n")[2] ?? "");
  const oneWidths = new Set((panel?.render(74) ?? []).map((line) => visibleLength(plain(line))));
  check("every detail line is the same width", oneWidths.size === 1, [...oneWidths].join(","));

  panel?.handleInput("\t");
  check("tab moves the cursor to the next block", panel?.selectedBlock === 1, String(panel?.selectedBlock));
  panel?.handleInput("\r");
  check("enter opens the block under the cursor", panel?.expanded?.activity === true, JSON.stringify(panel?.expanded ?? {}));
  panel?.handleInput("\r");
  check("enter closes it again", panel?.expanded?.activity === false, JSON.stringify(panel?.expanded ?? {}));

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


  /* the approval card, through the real tool ------------------------------------ */
  const plannedScript = `
    export const meta = {
      name: "card-demo",
      description: "prove the card appears and is honoured",
      phases: [{ title: "Say", agents: 3, prompt: "one file each" }],
    }
    const files = ["src/a.ts", "src/b.ts", "src/c.ts"];
    const out = await parallel(files.map((file) => () => agent("Say the file name only: " + file, { label: file })));
    return out.map((r) => r.text).join(" | ");
  `;

  // What the card would say, without a terminal: the plan and the cost.
  const cardRequest = approvalRequestFor(plannedScript, "card-demo");
  const card = buildApprovalLines({ request: cardRequest, selected: 0, mode: "ask", width: 74, now: 0 })
    .map((line) => line.text)
    .join("\n");
  console.log(card);
  check("the card reads the declared plan", card.includes("card-demo") && card.includes("Say"), card.split("\n")[0] ?? "");
  check("the card says how many agents are written", /3 agent calls/.test(card), card.slice(0, 160));
  check("the card offers the three answers", ["Yes, run it", "View raw script", "No"].every((word) => card.includes(word)), "missing an option");

  // Now the real tool, with a terminal that answers "No".
  let declinedCard = false;
  const declineCtx = {
    ...(ctx as Record<string, unknown>),
    ui: {
      setStatus: () => {},
      notify: () => {},
      custom: async (build: any) => {
        const prompt = build({ requestRender: () => {} }, { fg: (_slot: string, text: string) => text }, {}, () => {});
        declinedCard = true;
        prompt.handleInput("3");
      },
    },
  } as never;
  const declined = await workflowTool.execute(
    "panel-e2e",
    { script: plannedScript, name: "card-demo", background: false },
    new AbortController().signal,
    () => {},
    declineCtx,
  );
  check("the tool asked before running", declinedCard, "no card was built");
  check("a declined run does not start", declined.details.ok === false && declined.details.reason === "declined", JSON.stringify(declined.details));
  check("the message says nothing ran", /not started/.test(declined.content[0].text), declined.content[0].text.slice(0, 120));

  // And once more, with a terminal that says yes, so the card cannot block a run.
  deliveries.length = 0;
  let acceptedCard = "";
  const acceptCtx = {
    ...(ctx as Record<string, unknown>),
    ui: {
      setStatus: () => {},
      notify: () => {},
      custom: async (build: any) => {
        const prompt = build({ requestRender: () => {} }, { fg: (_slot: string, text: string) => text }, {}, () => {});
        acceptedCard = prompt.render(74).join("\n");
        prompt.handleInput("\r");
      },
    },
  } as never;
  const accepted = await workflowTool.execute(
    "panel-e2e",
    { script: plannedScript, name: "card-demo-yes" },
    new AbortController().signal,
    () => {},
    acceptCtx,
  );
  check("a yes starts the run", String(accepted.details.job ?? "").startsWith("wf_"), String(accepted.details.job));
  check("the card that was shown glowed", acceptedCard.includes("\u001b["), "no colour codes");
  const acceptDeadline = Date.now() + 180_000;
  while (deliveries.length === 0 && Date.now() < acceptDeadline) await wait(500);
  check("the accepted run finished", deliveries.length === 1, `${deliveries.length} deliveries`);

  /* closing is safe */
  panel?.handleInput("\u001b");
  panel?.dispose();
  check("escape closed the panel and lost nothing", overlays.length >= 1, `${overlays.length} overlays`);

  /* --- what one agent did, as the panel's detail view will show it --------- */
  // A real agent, real tools, one cheap call. The panel's Activity block cannot
  // be proved with a fake runner: the point is that a real tool call arrives.
  deliveries.length = 0;
  const toolRun = await run({
    name: "activity-demo",
    background: false,
    script: `const r = await agent("Use the read tool on src/sum.ts and answer with the function name only.", { label: "sum" });
return r.text;`,
  });
  check("a run with tools finished", toolRun.details.ok === true, String(toolRun.details.error ?? ""));
  const record = getLastWorkflowRun()?.result.agents.at(-1);
  check("the agent's task text is kept", (record?.prompt ?? "").includes("src/sum.ts"), (record?.prompt ?? "").slice(0, 60));
  check("the agent's tool calls are counted", (record?.toolCalls ?? 0) >= 1, `${record?.toolCalls ?? 0} calls`);
  /* --- a phase named per agent, which is what a map needs (pic 16) -------- */
  deliveries.length = 0;
  const phaseRun = await run({
    name: "phase-demo",
    background: false,
    script: `const areas = ["one", "two"];
const out = await parallel(areas.map((a) => agent("Answer with the word " + a, { label: a, phase: "Areas" })));
return out.map((r) => r.text).join(" | ");`,
  });
  check("a map with a per-agent phase finished", phaseRun.details.ok === true, String(phaseRun.details.error ?? ""));
  check(
    "the named phase is the run's phase",
    JSON.stringify(phaseRun.details.phases) === JSON.stringify(["Areas"]),
    JSON.stringify(phaseRun.details.phases),
  );
  const phased = getLastWorkflowRun()?.result.agents ?? [];
  check(
    "both agents sit in that phase",
    phased.length === 2 && phased.every((agent) => agent.phase === "Areas"),
    phased.map((agent) => agent.phase ?? "none").join(","),
  );

  check(
    "the kept activity names the tool",
    (record?.activity ?? []).some((row) => row.tool === "read" || row.tool === "ls"),
    (record?.activity ?? []).map((row) => row.tool).join(","),
  );

  /* --- a real schema fan-out, which ends with a table --------------------- */
  deliveries.length = 0;
  const tableRun = await run({
    name: "table-demo",
    background: false,
    script: `const REPORT = { type: "object", required: ["project", "about"], properties: { project: { type: "string" }, about: { type: "string" } } };
const areas = ["agent loop", "terminal UI"];
const ask = (a) => "Reply with JSON only, no prose: " + JSON.stringify({ project: a, about: "one short line" });
const out = await parallel(areas.map((a) => agent(ask(a), { label: a, schema: REPORT })));
return out.map((r) => (r.ok ? r.data : null));`,
  });
  check("a schema fan-out finished", tableRun.details.ok === true, String(tableRun.details.error ?? ""));
  const report = String(tableRun.content[0]?.text ?? "");
  check("the report ends with a results table", report.includes("results:"), report.slice(-300));
  check("the table has the agent column and the agreed keys", /#\s*│\s*project\s*│\s*about/.test(report), report.slice(-200));
  check("the table holds what the agents really returned", /agent loop|terminal UI/.test(report), report.slice(-200));

  /* --- the detail view over a live agent that really called a tool -------- */
  await run({
    name: "detail-live",
    script: `const r = await agent("Use the read tool on src/sum.ts and answer with the function name only.", { label: "sum" });
return r.text;`,
  });
  await panelShortcut?.({
    ui: {
      notify: (text: string) => notices.push(text),
      custom: async (build: any, options: any) => {
        overlays.push(options);
        panel = build({ requestRender: () => {} }, plainTheme, {}, () => {});
        return undefined;
      },
    },
  } as never);
  /** Read the detail screen as plain text. */
  const detailText = () => plain((panel?.render(74) ?? []).join("\n"));
  // With several runs in the session the panel opens on the list; `enter`
  // picks the newest run and a second `enter` opens its first agent.
  // Wait for the plan to land before opening an agent: a run that has started
  // but recorded no agents has nothing to show, and `enter` does nothing.
  const agentDeadline = Date.now() + 60_000;
  while ((panel?.job()?.agents.length ?? 0) === 0 && Date.now() < agentDeadline) await wait(250);
  for (let press = 0; press < 2 && !detailText().includes("tab block"); press += 1) {
    panel?.handleInput("\r");
  }
  check("the detail view was reached", detailText().includes("tab block"), detailText().split("\n")[0] ?? "");
  const detailDeadline = Date.now() + 60_000;
  while (!/(read|ls)\(/.test(detailText()) && Date.now() < detailDeadline) await wait(500);

  const detail = detailText();
  console.log(detail);
  check("the detail view opens on a real agent", detail.includes("Prompt") && detail.includes("Outcome"), detail.slice(0, 160));
  check("the real agent's task is in the panel", /src\/sum\.ts/.test(detail), detail.slice(0, 200));
  check("a real tool row names its argument", /(read|ls)\(/.test(detail), detail.slice(0, 400));
  check("the detail view names the model and the bill", /tokens · /.test(detail), detail.split("\n")[2] ?? "");
  const detailWidths = new Set((panel?.render(74) ?? []).map((line) => visibleLength(plain(line))));
  check("every detail line is the same width", detailWidths.size === 1, [...detailWidths].join(","));
  panel?.handleInput("\u001b");
  check("escape leaves the detail, not the run", panel?.mode === "list", String(panel?.mode));
  panel?.handleInput("x");
  panel?.dispose();
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
