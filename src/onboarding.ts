// First-run onboarding intro. Printed once on a user's first run.
export const INTRO_ENV_SKIP = "QRONOS_NO_INTRO";

// Engaging Orange Brand Palette
const ORANGE_BOLD = "\x1b[1;38;2;255;107;0m";
const ORANGE_LIGHT = "\x1b[38;2;255;170;86m";
const WHITE_BOLD = "\x1b[1;37m";
const MUTED = "\x1b[38;2;148;163;184m";
const EMERALD = "\x1b[38;2;16;185;129m";
const RESET = "\x1b[0m";

export const INTRO_TEXT = `
${ORANGE_BOLD}◈ Welcome to Qronos CLI${RESET} ${ORANGE_LIGHT}— autonomous AI coding agent in your terminal.${RESET}

  ${EMERALD}•${RESET} ${WHITE_BOLD}Inspects, edits, and creates files${RESET} ${MUTED}with surgical diffs.${RESET}
  ${EMERALD}•${RESET} ${WHITE_BOLD}Executes shell commands${RESET} ${MUTED}and handles git workflows natively.${RESET}
  ${EMERALD}•${RESET} ${WHITE_BOLD}Supports Bring Your Own Key (BYOK)${RESET} ${MUTED}with --provider (Anthropic, OpenAI, DeepSeek, Groq, Ollama)${RESET}
    ${MUTED}or the default Qronos AI Universal Gateway.${RESET}
  ${EMERALD}•${RESET} ${WHITE_BOLD}Resume any previous session with:${RESET}
    ${ORANGE_LIGHT}qronos-cli --session <id>${RESET}

${MUTED}Set ${INTRO_ENV_SKIP}=1 to skip this intro on future runs.${RESET}
`.trim();

/** True when the user opted out of the first-run intro via env. */
export function introSkipped(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env[INTRO_ENV_SKIP] || env.QRONOS_NO_INTRO;
  return v === "1" || v === "true";
}

/**
 * Print the first-run intro unless the user opted out.
 */
export function showIntro(log: (message: string) => void, env: NodeJS.ProcessEnv = process.env): void {
  if (introSkipped(env)) return;
  log(`\n${INTRO_TEXT}\n`);
}
