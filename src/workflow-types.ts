// Types shared by the workflow runtime, the sandbox and the tool.
//
// A workflow is a script the model writes. It fans work out to subagents and
// returns one value; only that value ever reaches the chat. These types are the
// contract between the three parts, so they stay free of implementation.

/** Tokens one agent burned. Mirrors the subagent runner's own counter. */
export interface WorkflowUsage {
  input: number;
  output: number;
  total: number;
}

/** What one `agent()` call asks for. */
export interface WorkflowAgentRequest {
  prompt: string;
  label?: string;
  /** JSON Schema the answer must satisfy. A string is parsed, never guessed. */
  schema?: unknown;
  /** Named subagent type, when the caller has one. */
  agentType?: string;
  /**
   * Model for this one agent. Claude Code lets a stage run on a cheaper model
   * (mechanical extraction) while the hard judgement stays on the strong one.
   */
  model?: string;
  /**
   * The phase this agent belongs to.
   *
   * `phase("Analyze")` sets the phase for everything after it, which is right
   * for a straight script. A `parallel` map needs a name per agent instead, so
   * that one call can put five agents in the same column. Blank means "the
   * current phase", so a script never has to repeat itself.
   */
  phase?: string;
  /**
   * Called once for every tool the agent finishes, so the panel can show
   * "6 tool calls · last 3: Bash, read, grep" while the agent is still working.
   *
   * Optional, because a fake runner in a test has no tools. It must never throw
   * into the agent: a display hook cannot be allowed to break a run.
   */
  onActivity?: (activity: { tool: string; turns: number; detail?: string }) => void;
  /**
   * Ask before a tool runs, when the chat's permission mode says a question is
   * needed. The runner calls this *instead of* running the tool.
   *
   * Optional, and its default is "no one to ask": a runner without it must not
   * become more permissive, so the caller decides what silence means.
   */
  approveTool?: (facts: WorkflowToolFacts) => Promise<WorkflowToolDecision>;
  /**
   * The grants this run has already been given ("allow for this run").
   *
   * A function, not the set: the runner may read it and may never change it, so
   * a subagent cannot grant itself anything.
   */
  toolGrants?: () => ReadonlySet<string>;
}

/** What a tool call would do, as far as the decision needs to know. */
export interface WorkflowToolFacts {
  name: string;
  kind: "read" | "write" | "shell" | "other";
  path?: string;
  command?: string;
  insideProject: boolean;
  dangerous: boolean;
  summary: string;
}

/** The answer to one ask. `grant` is what "allow for this run" adds. */
export interface WorkflowToolDecision {
  approved: boolean;
  grant?: string[];
  /** True when the user asked to switch the chat to auto mode. */
  switchToAuto?: boolean;
  /** True when there was no terminal to ask in. */
  skipped?: boolean;
}

/** What one `agent()` call gives back. It never throws: a script keeps going. */
export interface WorkflowAgentResult {
  ok: boolean;
  text: string;
  /** Validated data when a schema was requested and satisfied. */
  data?: unknown;
  error?: string;
  /** Tokens this agent cost, when the provider reports them. */
  usage?: WorkflowUsage;
  /** True when this answer came from the journal instead of a model call. */
  replayed?: boolean;
  /**
   * The context window of the model this agent ran on.
   *
   * Carried with the answer because the panel reads a job later, when there is
   * no registry to ask. Not journaled: a resumed agent asks the registry again.
   */
  contextWindow?: number;
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
  /** How deep `workflow()` may nest. Two means one child level. */
  maxDepth: number;
}

export const DEFAULT_CONCURRENCY = 16;
export const DEFAULT_MAX_AGENTS = 1000;
/** Ten minutes. A short cap turns a real audit into a failed audit. */
export const DEFAULT_WALL_CLOCK_MS = 600_000;
export const DEFAULT_MAX_LOG_LINES = 500;
export const DEFAULT_MAX_RESULT_CHARS = 200_000;
/** One nested level, as in Claude Code: a child workflow, never a grandchild. */
export const DEFAULT_MAX_DEPTH = 2;
/**
 * Tool calls kept per agent, for the panel's Activity block.
 *
 * Eight is what a person reads. The count of calls keeps rising past it; only
 * the rows are dropped, so "last 3 of 41 tool calls" is still true.
 */
export const MAX_ACTIVITY_ROWS = 8;
/**
 * How much of an agent's prompt is kept.
 *
 * The panel shows the first lines and says how many there are, so a long prompt
 * is not lost: it is cut at a size that a thousand agents can hold in memory.
 */
export const AGENT_PROMPT_LIMIT = 1_200;

export function workflowConfigFromEnv(env: NodeJS.ProcessEnv = process.env): WorkflowConfig {
  const int = (name: string, fallback: number, min: number, max: number) => {
    const value = Number.parseInt(env[name] ?? "", 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  };
  return {
    concurrency: int("QRONOS_WORKFLOW_CONCURRENCY", DEFAULT_CONCURRENCY, 1, 32),
    maxAgents: int("QRONOS_WORKFLOW_MAX_AGENTS", DEFAULT_MAX_AGENTS, 1, 2000),
    // Never below one minute: a workflow that cannot finish is not a workflow.
    wallClockMs: int("QRONOS_WORKFLOW_WALL_CLOCK_MS", DEFAULT_WALL_CLOCK_MS, 60_000, 3_600_000),
    maxLogLines: int("QRONOS_WORKFLOW_MAX_LOGS", DEFAULT_MAX_LOG_LINES, 10, 5000),
    maxResultChars: int("QRONOS_WORKFLOW_MAX_RESULT_CHARS", DEFAULT_MAX_RESULT_CHARS, 1000, 2_000_000),
    maxDepth: int("QRONOS_WORKFLOW_MAX_DEPTH", DEFAULT_MAX_DEPTH, 1, 3),
  };
}

export type WorkflowEvent =
  | { type: "run_start"; at: number; scriptChars: number; depth: number }
  | { type: "phase"; at: number; name: string; depth: number }
  | { type: "log"; at: number; message: string; depth: number }
  | {
      type: "agent_start";
      at: number;
      id: string;
      label: string;
      phase?: string;
      depth: number;
      model?: string;
      /** The task text, so a live agent's detail view has something to show. */
      prompt?: string;
    }
  | {
      type: "agent_activity";
      at: number;
      id: string;
      /** Tool that just finished. */
      tool: string;
      /** Its arguments, redacted and capped, for the Activity block. */
      detail?: string;
      turns: number;
      /**
       * Every tool call this agent has made so far.
       *
       * It is carried, not counted by the listener: events stop at forty, and a
       * listener that adds one per event would say "40 of 200" forever.
       */
      count: number;
      depth: number;
    }
  | { type: "paused"; at: number; depth: number }
  | { type: "resumed"; at: number; depth: number }
  | {
      type: "agent_end";
      at: number;
      id: string;
      label: string;
      ok: boolean;
      error?: string;
      phase?: string;
      durationMs: number;
      usage?: WorkflowUsage;
      depth: number;
      /** The answer, capped. The journal stores it so a resumed run can replay. */
      text?: string;
      /** True when this answer came from the journal instead of a model call. */
      replayed?: boolean;
      /** The call's scope and position, and a hash of the request it answered. */
      scope?: string;
      index?: number;
      fingerprint?: string;
      /** The task, the last few tool calls, and how many there were. */
      prompt?: string;
      /** The model this agent asked, and how much room it had. */
      model?: string;
      contextWindow?: number;
      activity?: WorkflowAgentActivity[];
      toolCalls?: number;
      /** The checked data, so the report can table it. Never journaled. */
      data?: unknown;
    }
  | {
      type: "run_end";
      at: number;
      ok: boolean;
      agents: number;
      durationMs: number;
      tokens: number;
      error?: string;
      depth: number;
    };

/** One tool call an agent made, kept only to show what it is doing. */
export interface WorkflowAgentActivity {
  /** Tool name as the runner reports it: `Bash`, `read`, `grep`. */
  tool: string;
  /** Its arguments, compacted, redacted and capped. Empty when there are none. */
  detail?: string;
  /** Which model turn the call belonged to. */
  turns: number;
  /** When the run's clock said it finished. */
  at: number;
}

/** One finished agent, kept for the report and `/workflows`. */
/** One attempt at an agent's task, kept so a report can show the whole story. */
export interface WorkflowAgentAttempt {
  at: number;
  ok: boolean;
  error?: string;
  /** What this attempt cost, when the provider said. */
  tokens?: number;
  durationMs?: number;
  /** The task, only when it was changed for this attempt. */
  prompt?: string;
}

export interface WorkflowAgentRecord {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
  /** The phase this agent ran in, when one was named. */
  phase?: string;
  durationMs: number;
  usage?: WorkflowUsage;
  /** 1 for a top-level workflow, 2 inside a nested one. */
  depth: number;
  /** True when this agent's answer was replayed from the journal, not called. */
  replayed?: boolean;
  /** The model this agent asked, when it was routed to one. */
  model?: string;
  /** How much room that model had: 1 000 000 shows as `[1m]` beside the name. */
  contextWindow?: number;
  /**
   * True when this agent was run again from the detail view.
   *
   * New work, not a replay: the tokens were spent a second time. The row says so,
   * because a report must never pass old work off as new — or new work as free.
   */
  restarted?: boolean;
  restartedAt?: number;
  /**
   * The restarts this agent has had, oldest first, capped at five.
   *
   * Each entry keeps what was really asked (`prompt` only when it changed), what
   * it cost and whether it worked, so a report can never pass attempt two off as
   * attempt one.
   */
  attempts?: WorkflowAgentAttempt[];
  /** The task it was given, redacted and capped. Never the whole world. */
  prompt?: string;
  /** The last few tool calls, newest last. */
  activity?: WorkflowAgentActivity[];
  /** Every tool call it made, including the ones past the kept rows. */
  toolCalls?: number;
  /**
   * The checked data when the agent was asked for a schema.
   *
   * Kept so the report can end with a table of what the run found. It is not
   * journaled: a resumed run re-reads the answer text and checks it again.
   */
  data?: unknown;
}

/** Per-phase totals, so the panel can say who did how much. */
export interface WorkflowPhaseStat {
  name: string;
  agents: number;
  failed: number;
  tokens: number;
  durationMs: number;
}

export interface WorkflowRunResult {
  ok: boolean;
  /** The script's return value, JSON-cloned. */
  value?: unknown;
  error?: string;
  /** Every agent the run started, in start order. */
  agents: WorkflowAgentRecord[];
  phases: string[];
  /** Agents, tokens and time per phase. */
  phaseStats: WorkflowPhaseStat[];
  logs: string[];
  durationMs: number;
  /** True when a cap stopped the run early. */
  truncated: boolean;
  /** Total tokens over every agent in this run, nested workflows included. */
  tokens: WorkflowUsage;
  /** How many agents were answered from the journal instead of a model call. */
  replayed?: number;
  /** Tokens the replayed agents had already spent in the earlier attempt. */
  replayedTokens?: WorkflowUsage;
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

export function addUsage(total: WorkflowUsage, more: WorkflowUsage | undefined): WorkflowUsage {
  if (!more) return total;
  return {
    input: total.input + (more.input || 0),
    output: total.output + (more.output || 0),
    total: total.total + (more.total || 0),
  };
}

export const emptyUsage = (): WorkflowUsage => ({ input: 0, output: 0, total: 0 });

/** `1234` -> `1.2k`, the way the working line shows counts. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return String(Math.round(count));
  if (count < 1_000_000) {
    const value = count / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
