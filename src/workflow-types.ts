// Types shared by the workflow runtime, the sandbox and the tool.
//
// A workflow is a script the model writes. It fans work out to subagents and
// returns one value; only that value ever reaches the chat. These types are the
// contract between the three parts, so they stay free of implementation.

/** What one `agent()` call asks for. */
export interface WorkflowAgentRequest {
  prompt: string;
  label?: string;
  /** JSON Schema the answer must satisfy. A string is parsed, never guessed. */
  schema?: unknown;
  /** Named subagent type, when the caller has one. */
  agentType?: string;
}

/** What one `agent()` call gives back. It never throws: a script keeps going. */
export interface WorkflowAgentResult {
  ok: boolean;
  text: string;
  /** Validated data when a schema was requested and satisfied. */
  data?: unknown;
  error?: string;
}

export type WorkflowAgentRunner = (
  request: WorkflowAgentRequest,
  signal: AbortSignal,
) => Promise<WorkflowAgentResult>;

export interface WorkflowConfig {
  /** Agents running at the same time. */
  concurrency: number;
  /** Hard cap on agents per run, so one prompt cannot cost hundreds of calls. */
  maxAgents: number;
  /** Wall clock for the whole run. Ten minutes: a fan-out over a repo needs it. */
  wallClockMs: number;
  /** Log lines kept, so a chatty script cannot fill memory. */
  maxLogLines: number;
  /** Result values are JSON-cloned; this caps the size. */
  maxResultChars: number;
}

export const DEFAULT_CONCURRENCY = 8;
export const DEFAULT_MAX_AGENTS = 60;
/** Ten minutes. A short cap turns a real audit into a failed audit. */
export const DEFAULT_WALL_CLOCK_MS = 600_000;
export const DEFAULT_MAX_LOG_LINES = 500;
export const DEFAULT_MAX_RESULT_CHARS = 200_000;

export function workflowConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WorkflowConfig {
  const int = (name: string, fallback: number, min: number, max: number) => {
    const value = Number.parseInt(env[name] ?? "", 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  };
  return {
    concurrency: int("QRONOS_WORKFLOW_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 32),
    maxAgents: int("QRONOS_WORKFLOW_MAX_AGENTS", DEFAULT_MAX_AGENTS, 1, 500),
    // Never below one minute: a workflow that cannot finish is not a workflow.
    wallClockMs: int("QRONOS_WORKFLOW_WALL_CLOCK_MS", DEFAULT_WALL_CLOCK_MS, 60_000, 3_600_000),
    maxLogLines: int("QRONOS_WORKFLOW_MAX_LOGS", DEFAULT_MAX_LOG_LINES, 10, 5000),
    maxResultChars: int("QRONOS_WORKFLOW_MAX_RESULT_CHARS", DEFAULT_MAX_RESULT_CHARS, 1000, 2_000_000),
  };
}

export type WorkflowEvent =
  | { type: "run_start"; at: number; scriptChars: number }
  | { type: "phase"; at: number; name: string }
  | { type: "log"; at: number; message: string }
  | { type: "agent_start"; at: number; id: string; label: string }
  | { type: "agent_end"; at: number; id: string; label: string; ok: boolean; error?: string }
  | { type: "run_end"; at: number; ok: boolean; agents: number; durationMs: number; error?: string };

export interface WorkflowRunResult {
  ok: boolean;
  /** The script's return value, JSON-cloned. */
  value?: unknown;
  error?: string;
  /** Every agent the run started, in start order. */
  agents: Array<{ id: string; label: string; ok: boolean; error?: string }>;
  phases: string[];
  logs: string[];
  durationMs: number;
  /** True when a cap stopped the run early. */
  truncated: boolean;
}

export class WorkflowLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowLimitError";
  }
}

export class WorkflowTimeoutError extends Error {
  constructor(ms: number) {
    super(`workflow stopped after ${Math.round(ms / 1000)}s (wall clock)`);
    this.name = "WorkflowTimeoutError";
  }
}

export class WorkflowSyntaxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowSyntaxError";
  }
}
