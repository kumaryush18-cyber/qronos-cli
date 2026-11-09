import { createInterface } from "node:readline/promises";
import {
  CONSENT_PROMPT,
  CONSENT_TEXT,
  NON_INTERACTIVE_CONSENT_TEXT,
  parseConsentAnswer,
} from "./consent";

export interface ConsentPromptDeps {
  /** process.stdin.isTTY — false/undefined for pipes, CI, cron. */
  stdinIsTTY: boolean;
  log: (message: string) => void;
  /** Shows `prompt` and resolves with one line of user input. */
  askLine: (prompt: string) => Promise<string>;
}

export async function promptConsent(deps: ConsentPromptDeps, text: string = CONSENT_TEXT): Promise<boolean> {
  if (!deps.stdinIsTTY) {
    deps.log(NON_INTERACTIVE_CONSENT_TEXT);
    return false;
  }
  deps.log(text);
  const answer = await deps.askLine(CONSENT_PROMPT);
  return parseConsentAnswer(answer);
}

export async function promptConsentInteractive(text?: string): Promise<boolean> {
  return promptConsent({
    stdinIsTTY: process.stdin.isTTY === true,
    log: (message) => console.log(message),
    askLine: async (prompt) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
  }, text);
}

export async function promptApiKeyInteractive(): Promise<string> {
  if (!process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const key = await rl.question("🔑 Enter your Qronos or OpenAI/Anthropic API Key (or press Enter to skip):\n> ");
    return key.trim();
  } finally {
    rl.close();
  }
}
