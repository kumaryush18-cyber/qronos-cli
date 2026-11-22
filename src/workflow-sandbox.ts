// Where a model-written workflow script runs.
//
// The script is real JavaScript, because that is the point: `await agent(...)`
// in a loop is how Claude Code's workflows look, and a declarative format would
// lose the branching that makes them useful.
//
// What protects the machine:
//   - a fresh vm context with no `process`, `require`, `fetch`, `Bun` or `fs`;
//   - `codeGeneration.strings = false`, so `eval` and the `Function` constructor
//     are refused *inside* the context (the classic `constructor.constructor`
//     escape hit a wall here);
//   - only the workflow helpers are handed in;
//   - a synchronous timeout, plus a wall clock in the runtime for awaits.
//
// This is a strong guardrail against accidents, not a formal sandbox against a
// determined attacker. The honest statement in docs/workflows.md says the same.
import { createContext, runInContext } from "node:vm";
import type { WorkflowAgentResult } from "./workflow-types";
import { WorkflowSyntaxError } from "./workflow-types";
import { createFrozenClock } from "./workflow-clock";

export interface AgentScriptOptions {
  label?: string;
  schema?: unknown;
  agent?: string;
  /** Route this one agent to a different model. */
  model?: string;
}

export interface WorkflowSandboxHelpers {
  agent(prompt: unknown, options?: AgentScriptOptions): Promise<WorkflowAgentResult>;
  parallel(items: unknown): Promise<unknown[]>;
  pipeline(items: unknown, fn: unknown): Promise<unknown[]>;
  phase(name: unknown): void;
  log(message: unknown): void;
  /** A nested workflow: one child level, as in Claude Code. */
  workflow(script: unknown): Promise<unknown>;
  /** Work passed in by the caller of the tool. */
  args?: unknown;
  /** Read-only view of the agent budget. */
  budget?: { maxAgents: number; used: () => number };
}

/** One stage a script says it will run, only ever used for display. */
export interface WorkflowPhasePreview {
  title: string;
  /** How many agents the author expects to start in this phase. */
  agents?: number;
  /** A sample task, so the approval card can show what an agent will be asked. */
  prompt?: string;
}

export interface WorkflowMeta {
  name?: string;
  description?: string;
  /**
   * The plan, written by the script itself:
   *
   *   export const meta = { name: "audit", phases: [{ title: "Analyze", agents: 5, prompt: "one file each" }] }
   *
   * It is read with a brace-balancing scan and a JSON parse, never by running the
   * script, so a preview cannot execute anything.
   */
  phases?: WorkflowPhasePreview[];
}

/** Read `export const meta = {...}` without executing anything. */
export function parseWorkflowMeta(script: string): WorkflowMeta {
  const anchor = /(?:export\s+)?const\s+meta\s*=\s*\{/.exec(script);
  if (!anchor) return {};
  const start = anchor.index + anchor[0].length - 1;
  // Balance braces so a nested object or a `}` inside a string cannot end it early.
  let depth = 0;
  let end = -1;
  let quote: string | undefined;
  for (let index = start; index < script.length; index += 1) {
    const ch = script[index]!;
    if (quote) {
      if (ch === "\\") index += 1;
      else if (ch === quote) quote = undefined;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "{") depth += 1;
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) return {};
  try {
    const normalized = script
      .slice(start, end + 1)
      .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":')
      .replace(/'/g, '"')
      // A hand-written object usually has a trailing comma. JSON has none, and a
      // preview must never fail just because the author wrote one.
      .replace(/,\s*}/g, "}")
      .replace(/,\s*]/g, "]");
    const parsed = JSON.parse(normalized) as Record<string, unknown>;
    return {
      name: typeof parsed.name === "string" ? parsed.name.slice(0, 80) : undefined,
      description: typeof parsed.description === "string" ? parsed.description.slice(0, 300) : undefined,
      phases: normalizePhases(parsed.phases),
    };
  } catch {
    return {};
  }
}

/** Keep a phase list readable and bounded; anything odd is dropped, not trusted. */
function normalizePhases(value: unknown): WorkflowPhasePreview[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: WorkflowPhasePreview[] = [];
  for (const entry of value.slice(0, 12)) {
    if (typeof entry === "string") {
      const title = entry.trim();
      if (title !== "") out.push({ title: title.slice(0, 60) });
      continue;
    }
    if (entry === null || typeof entry !== "object") continue;
    const raw = entry as Record<string, unknown>;
    const title = [raw.title, raw.name, raw.phase].find((item) => typeof item === "string" && item.trim() !== "");
    if (typeof title !== "string") continue;
    const agents = Number(raw.agents ?? raw.count);
    const prompt = [raw.prompt, raw.task, raw.example].find((item) => typeof item === "string" && item.trim() !== "");
    out.push({
      title: title.trim().slice(0, 60),
      agents: Number.isFinite(agents) && agents > 0 ? Math.min(1000, Math.round(agents)) : undefined,
      prompt: typeof prompt === "string" ? prompt.trim().slice(0, 160) : undefined,
    });
  }
  return out.length > 0 ? out : undefined;
}

/**
 * Turn an ESM-looking script into a body we can run.
 *
 * We accept `export const meta = ...` and top-level `return`, because that is
 * what Claude Code's examples look like. We refuse imports: a workflow that
 * needs a package would be a supply-chain hole wearing a hat.
 */
export function extractScriptBody(script: string): string {
  const trimmed = script.replace(/\r\n/g, "\n").trim();
  if (trimmed === "") throw new WorkflowSyntaxError("the workflow script is empty");
  if (/^\s*import\s/m.test(trimmed)) {
    throw new WorkflowSyntaxError("workflow scripts cannot import modules; use agent() for the work");
  }
  if (/\brequire\s*\(/.test(trimmed)) {
    throw new WorkflowSyntaxError("workflow scripts cannot require() modules");
  }
  if (/\bprocess\b|\bBun\b|node:fs|node:child_process/.test(trimmed)) {
    throw new WorkflowSyntaxError("workflow scripts have no process, Bun or filesystem access");
  }
  if (/\bsetInterval\b|\bsetImmediate\b/.test(trimmed)) {
    throw new WorkflowSyntaxError("workflow scripts cannot use setInterval; await handles time");
  }
  return trimmed.replace(/^\s*export\s+/gm, "");
}

const SAFE_GLOBALS = {
  Math,
  JSON,
  RegExp,
  Promise,
  Array,
  Object,
  String,
  Number,
  Boolean,
  Map,
  Set,
  WeakMap,
  WeakSet,
  Symbol,
  Intl,
  Error,
  TypeError,
  RangeError,
  SyntaxError,
  isNaN,
  isFinite,
  parseInt,
  parseFloat,
  encodeURIComponent,
  decodeURIComponent,
  structuredClone,
  setTimeout,
  clearTimeout,
};

export interface RunScriptOptions {
  /** Synchronous execution limit. Awaits are bounded by the runtime's wall clock. */
  syncTimeoutMs?: number;
  /**
   * The moment the script should believe it is, in ms. A resumed run passes the
   * original run's start, so a script that stamps or branches on the time makes
   * the same decisions the second time.
   */
  now?: number;
}

/**
 * Run the script and return its value.
 *
 * The helpers are the only way out of the context, so every side effect a
 * script can have is one the runtime chose to allow.
 */
export async function runWorkflowScript(
  script: string,
  helpers: WorkflowSandboxHelpers,
  options: RunScriptOptions = {},
): Promise<unknown> {
  const body = extractScriptBody(script);
  // `Math.random` is replaced by a seeded generator. Claude Code removes random
  // entirely so a resumed run repeats itself; a seeded generator keeps scripts
  // that use it working and still repeats itself, which is the property that
  // matters when we add resume.
  const seededMath = Object.create(Math) as Math;
  let seed = 0x2f6e2b1;
  seededMath.random = () => {
    // xorshift32: tiny, deterministic, and good enough for shuffles.
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1_000_000) / 1_000_000;
  };

  const context = createContext(
    {
      ...SAFE_GLOBALS,
      // A frozen clock: `Date.now()` and `new Date()` answer with one fixed
      // moment, so a replay repeats the original decisions. Explicit arguments
      // (`new Date(0)`) still work as usual.
      Date: createFrozenClock(options.now ?? Date.now()).dateClass,
      Math: seededMath,
      console: { log: (message: unknown) => helpers.log(message) },
      agent: (prompt: unknown, opts?: AgentScriptOptions) => helpers.agent(prompt, opts),
      parallel: (items: unknown) => helpers.parallel(items),
      pipeline: (items: unknown, fn: unknown) => helpers.pipeline(items, fn),
      phase: (name: unknown) => helpers.phase(name),
      log: (message: unknown) => helpers.log(message),
      workflow: (child: unknown) => helpers.workflow(child),
      args: helpers.args,
      budget: helpers.budget
        ? {
            maxAgents: helpers.budget.maxAgents,
            used: () => helpers.budget!.used(),
            get remaining() {
              return helpers.budget!.maxAgents - helpers.budget!.used();
            },
          }
        : undefined,
    },
    { name: "qronos-workflow", codeGeneration: { strings: false, wasm: false } },
  );

  const wrapped = `(async () => {\n${body}\n})()`;
  let pending: unknown;
  try {
    pending = runInContext(wrapped, context, {
      filename: "workflow.js",
      timeout: options.syncTimeoutMs ?? 10_000,
      displayErrors: true,
    });
  } catch (error) {
    throw asSyntaxError(error);
  }
  try {
    return await pending;
  } catch (error) {
    throw asRunError(error);
  }
}

function asSyntaxError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new WorkflowSyntaxError(message.slice(0, 500));
}

function asRunError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error).slice(0, 500));
}
