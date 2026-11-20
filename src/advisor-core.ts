// Advisor model, ported in spirit from can1357/oh-my-pi's advisor subsystem.
//
// The idea: a small, cheap model reviews each turn of the main agent and writes
// SHORT notes. It cannot edit files and cannot approve anything. Its only power
// is to say "your catch swallows network errors too" while the main agent is
// still in the room, so the mistake is fixed in the same session instead of by
// the user in review.
//
// Why a second model and not a longer prompt: a reviewer that never writes code
// can be a much cheaper model. One DeepSeek-Flash review per turn costs a few
// percent of the main turn.
//
// This file is pure logic (no pi imports) so the parsing and the cadence rules
// can be unit tested. advisor.ts holds the event wiring.
//
// Switch it on with:
//   QRONOS_ADVISOR=1            use the session model, review every turn
//   QRONOS_ADVISOR=off          disabled (default)
//   QRONOS_ADVISOR=<model id>   use that model (falls back to the session model)
//   QRONOS_ADVISOR_EVERY=3      review every 3rd turn instead of every turn

export const ADVISOR_SECTION = "advisor-notes";

export interface AdvisorConfig {
  enabled: boolean;
  /** Model selector for the reviewer; undefined means "same model as the session". */
  model?: string;
  /** Review every Nth turn. 1 = every turn. */
  everyTurns: number;
  /** Max notes accepted per review, so a chatty reviewer cannot flood the prompt. */
  maxNotes: number;
}

export const DEFAULT_ADVISOR: AdvisorConfig = { enabled: false, everyTurns: 1, maxNotes: 4 };
export const MAX_NOTES_CAP = 8;

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off", ""]);

/**
 * Read the env switch. Anything that is not obviously "off" but is a model id
 * ("deepseek-v4-flash") is treated as on-with-that-model, which is what a user
 * typing QRONOS_ADVISOR=deepseek-v4-flash means.
 */
export function parseAdvisorConfig(env: Record<string, string | undefined> = {}): AdvisorConfig {
  const raw = (env.QRONOS_ADVISOR ?? "").trim();
  const lower = raw.toLowerCase();

  const config: AdvisorConfig = { ...DEFAULT_ADVISOR };

  if (FALSY.has(lower)) return config;
  if (TRUTHY.has(lower)) config.enabled = true;
  else if (raw) {
    config.enabled = true;
    config.model = raw;
  }

  if (env.QRONOS_ADVISOR_MODEL?.trim()) config.model = env.QRONOS_ADVISOR_MODEL.trim();

  const every = Number.parseInt(env.QRONOS_ADVISOR_EVERY ?? "", 10);
  if (Number.isFinite(every) && every >= 1) config.everyTurns = Math.min(every, 50);

  const maxNotes = Number.parseInt(env.QRONOS_ADVISOR_MAX_NOTES ?? "", 10);
  if (Number.isFinite(maxNotes) && maxNotes >= 1) config.maxNotes = Math.min(maxNotes, MAX_NOTES_CAP);

  return config;
}

/** Cadence check. turnIndex is 1-based, as pi reports it. */
export function shouldReview(turnIndex: number, config: AdvisorConfig): boolean {
  if (!config.enabled) return false;
  if (turnIndex < 1) return false;
  return turnIndex % config.everyTurns === 0;
}

export interface ReviewInput {
  assistantText: string;
  /** The user message this turn answered, when known. */
  userText?: string;
  /** Tools the turn used, e.g. ["edit", "bash"]. */
  toolsUsed?: readonly string[];
  /** Files touched, when known. */
  filesTouched?: readonly string[];
}

/** The reviewer's own system prompt. Small on purpose: it must stay cheap. */
export const ADVISOR_SYSTEM_PROMPT = [
  "You are a senior reviewer sitting next to a coding agent. You do not write code.",
  "Read the agent's last turn and report only real problems the user would have to fix later:",
  "wrong assumptions, swallowed errors, missing edge cases, deleted safety checks, broken imports.",
  "Do not repeat the agent's own summary. Do not praise. Do not restate the request.",
  "If the turn is fine, reply exactly: NO_ISSUES",
  'Otherwise reply with JSON only: {"blocker":"one line or empty","notes":["note","note"]}',
  "A blocker means the code is wrong right now. Anything else is a note.",
].join("\n");

export function buildReviewPrompt(input: ReviewInput): string {
  const parts: string[] = [];
  if (input.userText) parts.push(`USER REQUEST:\n${clip(input.userText, 2000)}`);
  if (input.toolsUsed?.length) parts.push(`TOOLS USED: ${input.toolsUsed.join(", ")}`);
  if (input.filesTouched?.length) parts.push(`FILES TOUCHED: ${input.filesTouched.join(", ")}`);
  parts.push(`AGENT TURN:\n${clip(input.assistantText, 6000)}`);
  return parts.join("\n\n");
}

function clip(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}\n… (truncated)`;
}

export interface AdvisorAdvice {
  notes: string[];
  blocker?: string;
}

export const NO_ISSUES = "NO_ISSUES";

/** Phrases that mean "nothing to say" and must not become advice. */
const EMPTY_PHRASES = [/^no[\s_-]*issues?\.?$/i, /^nothing to add\.?$/i, /^lgtm\.?$/i, /^looks good\.?$/i];

/**
 * Parse whatever the reviewer returned. Tolerant on purpose: a JSON reply is
 * expected, but a model that answers with bullets must still work, and a model
 * that answers with prose must not be injected verbatim into the prompt.
 */
export function parseAdvisorAdvice(text: string, maxNotes = DEFAULT_ADVISOR.maxNotes): AdvisorAdvice {
  const cleaned = stripFences(text ?? "").trim();
  if (!cleaned || cleaned.toUpperCase() === NO_ISSUES) return { notes: [] };

  const parsed = tryJson(cleaned);
  if (parsed) {
    const notes = toStringList(parsed.notes).filter(isMeaningful);
    const blockerText = typeof parsed.blocker === "string" ? parsed.blocker.trim() : "";
    return {
      notes: notes.slice(0, maxNotes),
      blocker: blockerText && isMeaningful(blockerText) ? blockerText : undefined,
    };
  }

  const lines = cleaned
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
  const notes = lines.filter(isMeaningful).slice(0, maxNotes);
  return { notes };
}

function stripFences(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return fence ? fence[1] : text;
}

function tryJson(text: string): { notes?: unknown; blocker?: unknown } | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" ? (value as { notes?: unknown; blocker?: unknown }) : undefined;
  } catch {
    return undefined;
  }
}

function toStringList(value: unknown): string[] {
  if (typeof value === "string") return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean);
}

function isMeaningful(line: string): boolean {
  const text = line.trim();
  if (text.length < 4) return false;
  return !EMPTY_PHRASES.some((re) => re.test(text));
}

/**
 * The system section handed to the main agent on its next request. Kept short
 * and imperative: it is a correction from a colleague, not a new policy.
 */
export function formatAdvisorSection(advice: AdvisorAdvice): string | undefined {
  if (!advice.blocker && advice.notes.length === 0) return undefined;
  const lines = [`<${ADVISOR_SECTION}>`, "A reviewer read your last turn. Address this before continuing:"];
  if (advice.blocker) lines.push(`BLOCKER: ${advice.blocker}`);
  for (const note of advice.notes) lines.push(`- ${note}`);
  lines.push("Fix what is real, ignore what is not, and do not mention this note to the user.");
  lines.push(`</${ADVISOR_SECTION}>`);
  return lines.join("\n");
}

/** Status-line label, e.g. "advisor on · deepseek-v4-flash". */
export function advisorStatus(config: AdvisorConfig): string {
  if (!config.enabled) return "advisor off";
  const model = config.model ?? "session model";
  const cadence = config.everyTurns > 1 ? ` every ${config.everyTurns} turns` : "";
  return `advisor on · ${model}${cadence}`;
}
