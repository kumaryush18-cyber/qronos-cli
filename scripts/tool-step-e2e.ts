// End-to-end check for the Claude-style step name, against a REAL model.
//
// It builds the real runtime (our extensions included), asks the model to run a
// shell command with a NEUTRAL prompt, and then reads what the model actually
// sent: did it fill the optional `description` field on its own?
//
//   QRONOS_E2E_MODEL=claude-haiku-5.5 bun run scripts/tool-step-e2e.ts
//
// Exit code is 0 only when every check passed.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModelRegistry,
  SessionManager,
  createAgentSessionFromServices,
  createAgentSessionServices,
} from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { loadJwt } from "../src/credentials";
import { getCredentialsPath, getQronosAgentDir } from "../src/paths";
import { PROVIDER_PRESETS } from "../src/provider";
import { stepHeading, stepTitle } from "../src/tool-step";
import { createClaudeToolRendererExtension } from "../src/tool-renderer-claude";
import { STEP_MAX_CHARS } from "../src/tool-step";
import { visibleWidth } from "@earendil-works/pi-tui";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const scratch = mkdtempSync(join(tmpdir(), "qronos-tool-step-e2e-"));
const project = join(scratch, "demo-project");
const agentDir = join(scratch, "agent");
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, "README.md"), "# demo\n");
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
const { settingsManager, resourceLoaderOptions } = buildRuntimeOptions(opts, `tool-step-e2e-${Date.now()}`);
const services = await createAgentSessionServices({ cwd: project, agentDir, settingsManager, resourceLoaderOptions });
const registry = new ModelRegistry(services.modelRuntime);
await registry.refresh();
const model = registry.find("qronos", modelId) ?? registry.getAvailable().find((item) => item.id === modelId);
if (!model) throw new Error("no chat model in the registry");

// From the services, not createAgentSession: the provider (and its key) is
// registered by our own provider extension inside these services, so a fresh
// session built any other way has no credentials.
const { session } = await createAgentSessionFromServices({
  services,
  sessionManager: SessionManager.create(project),
  model,
  tools: ["bash", "read", "ls"],
});

/* --- 1. the model is really offered the field ----------------------------- */

const definition = session.getToolDefinition("bash") as { parameters?: any; promptGuidelines?: string[] } | undefined;
const declared = Boolean(definition?.parameters?.properties?.description);
check("the declared bash schema offers `description`", declared);
check(
  "`description` is optional (only `command` is required)",
  Array.isArray(definition?.parameters?.required) && !definition!.parameters.required.includes("description"),
  JSON.stringify(definition?.parameters?.required),
);
check(
  "the step guideline reaches the system prompt",
  (definition?.promptGuidelines ?? []).some((line) => line.includes("description")),
);

/* --- 2. a neutral prompt, so compliance is measured, not requested -------- */

const bashCalls: Array<Record<string, unknown>> = [];
session.subscribe((event: any) => {
  if (event?.type === "tool_execution_start" && event.toolName === "bash") bashCalls.push(event.args ?? {});
});

const guard = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error("the model did not finish in 180s")), 180_000),
);
// Three separate calls on purpose: one chained command would give us a
// compliance sample of one.
await Promise.race([
  session.prompt(
    "Do these three things with three separate shell calls: list the files, print README.md, then show git status.",
  ),
  guard,
]);

/* --- 3. what the model really sent --------------------------------------- */

check("the model called bash at least once", bashCalls.length > 0, `${bashCalls.length} call(s)`);
const described = bashCalls.filter((args) => typeof args.description === "string" && String(args.description).trim() !== "");
check(
  "every bash call carried a usable description",
  bashCalls.length > 0 && described.length === bashCalls.length,
  `${described.length}/${bashCalls.length}`,
);

/* --- 4. what the transcript would draw ----------------------------------- */

const sample = described[0] ?? {};
const heading = stepHeading(sample);
check("the call renders a step heading", Boolean(heading?.title), heading?.title ?? "");
check(
  "the step name fits the cap",
  Boolean(heading) && stepTitle(sample)!.length <= STEP_MAX_CHARS,
  `${stepTitle(sample)?.length ?? 0} chars`,
);

let resolver: ((name: string, next: () => undefined) => any) | undefined;
(createClaudeToolRendererExtension() as { factory: (p: never) => void }).factory({
  registerMarkdownTransformer: () => {},
  registerToolRenderer: (r: any) => {
    resolver = r;
  },
} as never);
const width = 80;
Object.defineProperty(process.stdout, "columns", { value: width, configurable: true });
const renderers = resolver!("bash", () => undefined);
const theme = { fg: (_role: string, text: string) => text, bold: (text: string) => text };
const lines: string[] = renderers
  .renderCall(sample, theme, { isPartial: false, durationMs: 1200, isError: false, args: sample })
  .render(width);
check("the transcript draws two lines", lines.length === 2, `${lines.length} line(s)`);
check("line 1 is the step name", lines[0]?.includes(heading?.title ?? "\u0000") === true, lines[0]?.trim());
check("line 2 is the command", lines[1]?.includes("$") === true, lines[1]?.trim());
check(
  "both lines fit the width",
  lines.every((line) => visibleWidth(line) <= width),
  lines.map((line) => visibleWidth(line)).join(","),
);

console.log(`\nmodel: ${modelId}`);
console.log(`bash calls: ${bashCalls.length}, with description: ${described.length}`);
for (const args of bashCalls) {
  console.log(`  \u2022 ${String(args.description ?? "(none)").slice(0, 80)}  \u2014  ${String(args.command ?? "").slice(0, 60)}`);
}

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) FAILED: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nAll checks PASSED.");
