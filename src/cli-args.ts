// Pure argv parsing for the local commands (help / version / logout / mcp) and the
// BYOK (Bring Your Own Key) & session flags.
import { CLI_VERSION } from "./version";

export interface RunOptions {
  session?: string;
  provider?: string;
  model?: string;
  apiKey?: string;
  baseUrl?: string;
  dangerouslySkipPermissions?: boolean;
}

export type CliCommand =
  | { kind: "run"; options?: RunOptions }
  | { kind: "init" }
  | { kind: "help" }
  | { kind: "version" }
  | { kind: "logout" }
  | { kind: "mcp"; args: string[] }
  | { kind: "unknown"; arg: string };

export const HELP_TEXT = `
◈ qronos-cli — autonomous AI coding agent in your terminal powered by Qronos AI.

Usage:
  qronos-cli                             start a new coding session (default: Qronos Gateway)
  qronos-cli init                        initialize project instructions (creates QRONOS.md)
  qronos-cli -c, --continue              continue the most recent coding session
  qronos-cli -r, --resume [id]           resume the most recent session (or specify session ID)
  qronos-cli -s, --session <id>          resume a specific session by ID
  qronos-cli --provider <name>           use specific provider (qronos, openai, anthropic, deepseek, ollama)
  qronos-cli --api-key <key>             supply direct API key (or set via env var)
  qronos-cli --base-url <url>            supply custom OpenAI-compatible endpoint
  qronos-cli --model <model>             use specific model (e.g. deepseek-v4-flash, gpt-4o, claude-3-7-sonnet)
  qronos-cli --dangerously-skip-permissions  skip all permission confirmation prompts
  qronos-cli logout                      remove stored sign-in credentials
  qronos-cli mcp <command>               manage Model Context Protocol tools (qronos-cli mcp --help)
  qronos-cli --version                   print CLI version
  qronos-cli --help                      show this help

Supported Providers (--provider):
  qronos     Qronos AI Universal Gateway (default, https://api.qronos.me)
  openai     Direct OpenAI API (https://api.openai.com/v1)
  anthropic  Direct Anthropic Claude Messages API (https://api.anthropic.com)
  deepseek   Direct DeepSeek API (https://api.deepseek.com/v1)
  openrouter Direct OpenRouter API (https://openrouter.ai/api/v1)
  groq       Direct Groq API (https://api.groq.com/openai/v1)
  ollama     Local Ollama instance (http://localhost:11434/v1)

Environment Variables:
  QRONOS_API_KEY             direct Qronos AI API key (sk_live_...)
  OPENAI_API_KEY             direct OpenAI API key (sk-...)
  ANTHROPIC_API_KEY          direct Anthropic Claude API key (sk-ant-...)
  DEEPSEEK_API_KEY           direct DeepSeek API key (sk-...)
  OPENROUTER_API_KEY         direct OpenRouter API key (sk-or-...)
  GROQ_API_KEY               direct Groq API key (gsk_...)
  QRONOS_BASE_URL            override Qronos backend URL (default https://api.qronos.me)
`.trim();

export function versionLine(): string {
  return `qronos-cli ${CLI_VERSION}`;
}

export function parseCliArgs(argv: readonly string[]): CliCommand {
  const [first, ...rest] = argv;
  if (first === undefined) return { kind: "run", options: {} };

  if (first === "mcp") return { kind: "mcp", args: rest };
  if (first === "init") return { kind: "init" };
  if (first === "--help" || first === "-h" || first === "help") return { kind: "help" };
  if (first === "--version" || first === "-v" || first === "version") return { kind: "version" };
  if (first === "logout") return { kind: "logout" };

  const options: RunOptions = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === "--session" || arg === "-s") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) return { kind: "unknown", arg: arg };
      options.session = val;
    } else if (arg === "--continue" || arg === "-c") {
      options.session = "latest";
    } else if (arg === "--resume" || arg === "-r" || arg === "-resume") {
      const next = argv[i + 1];
      if (next && !next.startsWith("-")) {
        options.session = next;
        i++;
      } else {
        options.session = "latest";
      }
    } else if (arg === "--provider" || arg === "-p") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) return { kind: "unknown", arg: arg };
      options.provider = val.toLowerCase();
    } else if (arg === "--api-key" || arg === "-k") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) return { kind: "unknown", arg: arg };
      options.apiKey = val;
    } else if (arg === "--base-url" || arg === "-u") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) return { kind: "unknown", arg: arg };
      options.baseUrl = val;
    } else if (arg === "--model" || arg === "-m") {
      const val = argv[++i];
      if (!val || val.startsWith("-")) return { kind: "unknown", arg: arg };
      options.model = val;
    } else if (arg === "--dangerously-skip-permissions") {
      options.dangerouslySkipPermissions = true;
    } else {
      return { kind: "unknown", arg: arg ?? "" };
    }
    i++;
  }

  return { kind: "run", options };
}
