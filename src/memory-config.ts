// Memory settings, read from the environment.
//
// Memory is ON by default: a new user does not know that `/memory` exists, and a
// feature nobody switches on teaches nobody anything. It is cheap (one reading
// of a small file per session) and every spending path is separate and capped.
//
//   QRONOS_MEMORY=0            turn the whole feature off
//   QRONOS_MEMORY_AUTO=0       keep memory, but never run a background sync
//   QRONOS_MEMORY_MODEL=<id>   model used for extraction (default: session model)
//   QRONOS_MEMORY_BUDGET=1200  approximate tokens injected into the prompt
//   QRONOS_MEMORY_MIN_TURNS=6  new turns needed before a sync is worth a call
//   QRONOS_MEMORY_INTERVAL_MIN=30  minutes between automatic syncs
//   QRONOS_MEMORY_STATUS=0     hide the `memory 12` footer line
export interface MemoryConfig {
  /** Master switch. False means the extension registers and does nothing. */
  enabled: boolean;
  /** Background consolidation at session start. */
  auto: boolean;
  /** Extraction model id; undefined = the session model. */
  model?: string;
  /** Approximate prompt budget for the injected block. */
  budgetTokens: number;
  /** New journal rows needed before a sync runs. */
  minTurns: number;
  /** Minimum gap between automatic syncs. */
  minIntervalMs: number;
  /** Show the `memory N` status line. */
  statusLine: boolean;
}

export const BUDGET_MIN = 200;
export const BUDGET_MAX = 8000;
export const MIN_TURNS_MIN = 1;
export const MIN_TURNS_MAX = 100;

export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  auto: true,
  budgetTokens: 1200,
  minTurns: 6,
  minIntervalMs: 30 * 60_000,
  statusLine: true,
};

const FALSY = new Set(["0", "false", "no", "off", "disable", "disabled"]);

function isOff(value: string | undefined): boolean {
  if (value === undefined) return false;
  return FALSY.has(value.trim().toLowerCase());
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** Parse the environment into a config. Never throws; bad values fall back. */
export function memoryConfigFromEnv(env: Record<string, string | undefined> = process.env): MemoryConfig {
  const enabled = !isOff(env.QRONOS_MEMORY);
  const model = env.QRONOS_MEMORY_MODEL?.trim();
  const intervalMinutes = clampInt(env.QRONOS_MEMORY_INTERVAL_MIN, 30, 1, 24 * 60);
  return {
    enabled,
    auto: enabled && !isOff(env.QRONOS_MEMORY_AUTO),
    model: model === "" ? undefined : model,
    budgetTokens: clampInt(env.QRONOS_MEMORY_BUDGET, DEFAULT_MEMORY_CONFIG.budgetTokens, BUDGET_MIN, BUDGET_MAX),
    minTurns: clampInt(env.QRONOS_MEMORY_MIN_TURNS, DEFAULT_MEMORY_CONFIG.minTurns, MIN_TURNS_MIN, MIN_TURNS_MAX),
    minIntervalMs: intervalMinutes * 60_000,
    statusLine: !isOff(env.QRONOS_MEMORY_STATUS),
  };
}
