// End-to-end check for compaction, against a REAL model.
//
// It runs a real agent session, then asks our compaction handler to summarise
// that real history — the same input pi hands over on `session_before_compact`.
// Nothing is stubbed: the messages come from the session, the summary comes from
// the model, and the checks read the result the next prompt would receive.
//
//   QRONOS_E2E_MODEL=glm-5.3-flash bun run scripts/compact-e2e.ts
//
// Exit code is 0 only when every step passed.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  ModelRegistry,
  createAgentSessionFromServices,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { loadJwt } from "../src/credentials";
import { getCredentialsPath, getQronosAgentDir } from "../src/paths";
import { PROVIDER_PRESETS } from "../src/provider";
import { createCompactHandlers, compactConfigFromEnv } from "../src/compact-extension";
import { digestMessagesForCompaction } from "../src/compact-input";

const failures: string[] = [];
function check(name: string, ok: boolean, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

const scratch = mkdtempSync(join(tmpdir(), "qronos-compact-e2e-"));
const project = join(scratch, "demo-project");
const agentDir = join(scratch, "agent");
mkdirSync(join(project, ".git"), { recursive: true });
mkdirSync(join(project, "src"), { recursive: true });
writeFileSync(join(project, "src", "sum.ts"), "export function sum(a: number, b: number) { return a + b; }\n");

const jwt = (await loadJwt(getCredentialsPath(getQronosAgentDir()))) || process.env.QRONOS_API_KEY || "";
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
const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, `compact-e2e-${Date.now()}`);
const services = await createAgentSessionServices({ cwd: project, agentDir, settingsManager, resourceLoaderOptions });
const { session } = await createAgentSessionFromServices({
  services,
  sessionManager: SessionManager.inMemory(project),
  tools: [...tools],
});

try {
  console.log(`model: ${modelId}\nproject: ${project}\n`);
  await session.prompt("Read src/sum.ts and tell me in one line what it does. Do not change any file.");
  await session.prompt("Add a short comment above the function explaining it. Then reply DONE.");

  const messages = [...session.messages];
  check("the session produced real history", messages.length >= 6, `${messages.length} messages`);

  const digest = digestMessagesForCompaction(messages, project);
  check("the pruned transcript is much smaller than the history", digest.transcript.length > 0);
  check("the tool layer recorded the file that was touched", digest.evidence.files.includes("src/sum.ts"), digest.evidence.files.join(", "));
  console.log(
    `\ndigest: ${digest.stats.messages} messages -> ${digest.transcriptChars} chars of transcript, ` +
      `${digest.evidence.files.length} file(s), ${digest.evidence.commands.length} command(s), ${digest.evidence.errors.length} error(s)\n`,
  );

  const registry = new ModelRegistry(services.modelRuntime);
  await registry.refresh();
  const model = registry.find("qronos", modelId) ?? registry.getAvailable().find((item) => item.id === modelId) ?? registry.getAvailable()[0];
  if (!model) throw new Error("no chat model in the registry");
  const auth = await registry.getApiKeyAndHeaders(model);

  const handlers = createCompactHandlers({
    config: { ...compactConfigFromEnv({}), minMessages: 1 },
    complete: async (_model, systemPrompt, prompt) => {
      const response = (await completeSimple(
        model as never,
        {
          systemPrompt,
          messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: prompt }] }],
        },
        { apiKey: auth.apiKey, headers: auth.headers },
      )) as { content?: unknown };
      const content = response.content;
      if (typeof content === "string") return content;
      if (!Array.isArray(content)) return "";
      return content
        .filter((block): block is { type: string; text: string } => !!block && typeof block === "object" && (block as { type: string }).type === "text")
        .map((block) => block.text)
        .join("\n");
    },
  });

  const statuses: Array<{ key: string; text?: string }> = [];
  const fakeCtx = {
    cwd: project,
    model,
    modelRegistry: registry,
    ui: { setStatus: (key: string, text?: string) => statuses.push({ key, text }) },
  };

  const result = (await handlers.summarize(
    {
      preparation: {
        messagesToSummarize: messages,
        turnPrefixMessages: [],
        firstKeptEntryId: "entry-1",
        tokensBefore: 40_000,
        isSplitTurn: false,
      },
      reason: "manual",
    },
    fakeCtx as never,
  )) as { compaction?: { summary: string; estimatedTokensAfter: number; details?: unknown } };

  const summary = result.compaction?.summary ?? "";
  console.log("--- checkpoint ---\n" + summary + "\n------------------\n");
  check("a checkpoint came back", result.compaction !== undefined);
  check("the checkpoint has the required headings", ["## Goal", "## Progress", "## Next Steps"].every((heading) => summary.includes(heading)));
  check("the exact file path survived", summary.includes("src/sum.ts"));
  check("the checkpoint is short enough to be worth having", summary.length < 12_000, `${summary.length} chars`);
  check("no secret shape in the checkpoint", !/AKIA|ghp_|sk-[A-Za-z0-9]{10}/.test(summary));
  const status = statuses.at(-1)?.text ?? "";
  console.log(`status line: ${status}`);
  check("the status line reports the saving", status.includes("compacted"));
} finally {
  session.dispose();
  if (failures.length === 0 && !process.env.QRONOS_E2E_KEEP) rmSync(scratch, { recursive: true, force: true });
  else console.log(`kept scratch dir for inspection: ${scratch}`);
}

console.log(failures.length === 0 ? "\nALL CHECKS PASSED" : `\nFAILED: ${failures.join(", ")}`);
process.exit(failures.length === 0 ? 0 : 1);
