// First-run onboarding intro. Printed once on a user's first run.
export const INTRO_ENV_SKIP = "QRONOS_NO_INTRO";

export const INTRO_TEXT = `
⚡ Welcome to Qronos CLI — autonomous AI coding agent in your terminal.

  • Inspects, edits, and creates files with surgical diffs.
  • Executes shell commands and handles git workflows natively.
  • Supports Bring Your Own Key (BYOK) with --provider (Anthropic, OpenAI, DeepSeek, Groq, Ollama)
    or the default Qronos AI Universal Gateway.
  • Resume any previous session with:
    qronos-cli --session <id>

Set ${INTRO_ENV_SKIP}=1 to skip this intro on future runs.
`.trim();

/** True when the user opted out of the first-run intro via env. */
export function introSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[INTRO_ENV_SKIP] || env.FREEPI_NO_INTRO;
  return v === "1" || v === "true";
}

/**
 * Print the first-run intro unless the user opted out.
 */
export function showIntro(log: (message: string) => void, env: NodeJS.ProcessEnv = process.env): void {
  if (introSkipped(env)) return;
  log(`\n${INTRO_TEXT}\n`);
}
