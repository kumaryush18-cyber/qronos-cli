// End-to-end check for the `apply_patch` (hashline) and `lsp` tools.
//
// It runs a REAL agent session through the same runtime wiring the TUI uses,
// so a prompt exercises the real model, the real tools and the real files on
// disk — not a stub. Output is one line per tool call plus the final answer.
//
//   bun run scripts/e2e-check.ts "prompt text" ["second prompt" ...]
//
// Needs credentials in ~/.qronos/agent (the same ones the CLI uses) and a
// working model. Point it at a scratch directory with QRONOS_E2E_CWD.
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager } from "@earendil-works/pi-coding-agent";
import { buildRuntimeOptions, type LaunchOptions } from "../src/pi-launch";
import { loadJwt } from "../src/credentials";
import { getCredentialsPath, getQronosAgentDir } from "../src/paths";
import { PROVIDER_PRESETS } from "../src/provider";

const prompts = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
if (prompts.length === 0) {
  console.error("usage: bun run scripts/e2e-check.ts <prompt> [prompt...]");
  process.exit(2);
}

const cwd = process.env.QRONOS_E2E_CWD || process.cwd();
const agentDir = getQronosAgentDir();
const jwt = (await loadJwt(getCredentialsPath(agentDir))) || process.env.QRONOS_API_KEY || "";
if (!jwt) {
  console.error("No credentials found. Run `qronos-cli` and log in first.");
  process.exit(2);
}

const opts: LaunchOptions = {
  baseUrl: process.env.QRONOS_API_BASE || PROVIDER_PRESETS.qronos.baseUrl,
  jwt,
  agentDir,
  model: process.env.QRONOS_E2E_MODEL || process.env.QRONOS_MODEL || "claude-haiku-5.5",
};
const { settingsManager, resourceLoaderOptions, tools } = buildRuntimeOptions(opts, `e2e-${Date.now()}`);

const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, resourceLoaderOptions });
const { session } = await createAgentSessionFromServices({
  services,
  sessionManager: SessionManager.inMemory(cwd),
  tools: [...tools],
});

// Print every tool the model runs, so a silent "it worked" is impossible.
const toolLines: string[] = [];
session.subscribe((event: any) => {
  if (event.type === "tool_execution_start") {
    console.log(`\n[tool] ${event.toolName} ${JSON.stringify(event.args ?? {}).slice(0, 300)}`);
  }
  if (event.type === "tool_execution_end") {
    const text = event.result?.content?.[0]?.text ?? "";
    console.log(`[tool ${event.toolName}${event.isError ? " FAILED" : ""}] ${String(text).slice(0, 700)}`);
    toolLines.push(`${event.toolName}${event.isError ? " FAILED" : ""}`);
  }
});

try {
  for (const [index, prompt] of prompts.entries()) {
    console.log(`\n=== prompt ${index + 1}: ${prompt}`);
    const started = Date.now();
    await session.prompt(prompt);
    const [last] = [...session.messages].reverse().filter((m: any) => m.role === "assistant");
    const text = (last as any)?.content?.filter?.((p: any) => p.type === "text").map((p: any) => p.text).join("\n") ?? "";
    console.log(`=== answer ${index + 1} (${Math.round((Date.now() - started) / 1000)}s)\n${text}`);
    // A shell command to run between prompts, so a test can change a file
    // behind the model's back (that is what makes a stale tag observable).
    const between = process.env.QRONOS_E2E_BETWEEN;
    if (between && index < prompts.length - 1) {
      console.log(`=== between: ${between}`);
      const run = Bun.spawnSync(["/bin/sh", "-c", between], { cwd, stdout: "inherit", stderr: "inherit" });
      console.log(`=== between exit ${run.exitCode}`);
    }
  }
} finally {
  session.dispose();
}