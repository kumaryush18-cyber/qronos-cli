// End-to-end check for memory, against a REAL model.
//
// What it proves, in order:
//   1. the extension journals real turns from a real agent session;
//   2. consolidation reads that journal and writes MEMORY.md;
//   3. the block injected into the next session contains what was learned.
//
// Nothing here is stubbed: real session, real model, real files in a temp dir.
//
//   QRONOS_E2E_MODEL=glm-5.3-flash bun run scripts/memory-e2e.ts
//
// Needs the same credentials the CLI uses. Costs two small turns plus one
// extraction call. Exit code is 0 only when every step passed.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { loadJwt } from "../src/credentials";
import { getCredentialsPath, getQronosAgentDir } from "../src/paths";
import { PROVIDER_PRESETS } from "../src/provider";
import { consolidate } from "../src/memory-consolidate";
import { buildMemoryBlock } from "../src/memory-inject";
import { parseDoc } from "../src/memory-doc";
import { parseLessons } from "../src/memory-lessons";
import { findRepoRoot, memoryFiles } from "../src/memory-paths";
import { EXTRACTION_SYSTEM_PROMPT, buildExtractionPrompt, selectEntries } from "../src/memory-extract";
import { readJournal, readText, readState } from "../src/memory-store";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const scratch = mkdtempSync(join(tmpdir(), "qronos-memory-e2e-"));
const project = join(scratch, "demo-project");
const agentDir = join(scratch, "agent");
mkdirSync(join(project, ".git"), { recursive: true });
mkdirSync(agentDir, { recursive: true });

const credentialsPath = getCredentialsPath(getQronosAgentDir());
const jwt = (await loadJwt(credentialsPath)) || process.env.QRONOS_API_KEY || "";
if (!jwt) {
  console.error("No credentials found. Run `qronos-cli` and log in first.");
  process.exit(2);
}

const modelId = process.env.QRONOS_E2E_MODEL || "glm-5.3-flash";
const opts: LaunchOptions = {
  baseUrl: process.env.QRONOS_API_BASE || PROVIDER_PRESETS.qronos.baseUrl,
  jwt,
  agentDir,
  model: modelId,
};
const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, `memory-e2e-${Date.now()}`);
const services = await createAgentSessionServices({ cwd: project, agentDir, settingsManager, resourceLoaderOptions });
const { session } = await createAgentSessionFromServices({
  services,
  sessionManager: SessionManager.inMemory(project),
  tools: [...tools],
});

const paths = memoryFiles(agentDir, project, findRepoRoot(project));

try {
  console.log(`model: ${modelId}\nproject: ${project}\nmemory:  ${paths.root}\n`);
  await session.prompt(
    "Remember for later sessions in this project: every test run must use `bun test --bail`. Reply with just OK.",
  );
  await session.prompt(
    "Remember for later sessions in this project: this project uses bun, never npm. Reply with just OK.",
  );

  const journal = readJournal(paths);
  check("real turns were journaled", journal.length >= 2, `${journal.length} row(s)`);
  check("every journal row carries the user prompt", journal.every((row) => row.prompt !== ""));
  check("at least one row carries the answer text", journal.some((row) => row.answer !== ""));
  check(
    "no secret shape leaked into the journal",
    journal.every((row) => !/AKIA|ghp_|sk-/.test(row.prompt + row.answer)),
  );

  const picked = selectEntries(journal, readState(paths).lastSeq);
  check("entries selected for extraction", picked.length >= 2, `${picked.length}`);

  const registry = new ModelRegistry(services.modelRuntime);
  await registry.refresh();
  const model =
    registry.find("qronos", modelId) ??
    registry.getAvailable().find((item) => item.id === modelId) ??
    registry.getAvailable()[0];
  if (!model) throw new Error("no chat model in the registry");
  console.log(`extraction model: ${(model as { provider?: string }).provider}/${(model as { id?: string }).id}`);
  const auth = await registry.getApiKeyAndHeaders(model);

  const result = await consolidate({
    paths,
    projectName: "demo-project",
    extract: async (system, user) => {
      const response = (await completeSimple(
        model as never,
        {
          systemPrompt: system,
          messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: user }] }],
        },
        { apiKey: auth.apiKey, headers: auth.headers },
      )) as { content?: unknown; stopReason?: string; errorMessage?: string };
      if (process.env.QRONOS_E2E_DEBUG) console.log("[raw]", JSON.stringify(response).slice(0, 900));
      const content = response.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((block): block is { type: string; text: string } => !!block && typeof block === "object" && (block as { type: string }).type === "text")
        .map((block) => block.text)
        .join("\n");
    },
  });

  console.log(`\nconsolidate: ${result.status}${result.reason ? ` (${result.reason})` : ""}, added ${result.added}\n`);
  check("consolidation reported synced", result.status === "synced", result.status);

  const docText = readText(paths.doc) ?? "";
  console.log("--- MEMORY.md ---\n" + docText + "-----------------\n");
  const doc = parseDoc(docText);
  const total = Object.values(doc.sections).reduce((sum, list) => sum + list.length, 0);
  check("MEMORY.md has at least one item", total > 0, `${total} item(s)`);
  check(
    "the model kept the project facts (bail flag or bun)",
    /bail|bun/i.test(docText),
    docText.slice(0, 120).replace(/\n/g, " "),
  );

  const block = buildMemoryBlock({
    doc,
    lessons: parseLessons(readText(paths.lessons)),
    paths,
    budgetTokens: 1200,
  });
  console.log("--- injected block ---\n" + block + "----------------------\n");
  check("the next session gets a memory block", block !== "");
  check("the block is a hint, not an order", block.includes("trust the code or the user"));
  check("the journal was consumed", readJournal(paths).length === 0);
} finally {
  session.dispose();
  if (failures.length === 0 && !process.env.QRONOS_E2E_KEEP) rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept scratch dir for inspection: ${scratch}`);
}

console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\nFAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
