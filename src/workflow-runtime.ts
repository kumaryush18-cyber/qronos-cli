// The workflow runtime: phases, fan-out, caps, schema, tokens, and one result.
//
// A run is a script plus a bag of helpers. Everything a script can do
// (`agent`, `parallel`, `pipeline`, `workflow`) goes through this class, which is
// why the caps, the schema check and the event log cannot be bypassed by it.
//
// It is deliberately not aware of pi, the chat UI or the model: it takes a
// `runAgent` function. That keeps the whole thing testable with a fake agent
// (no tokens, no wait) and lets the tool wire the real subagent later.
import {
  DEFAULT_MAX_LOG_LINES,
  DEFAULT_MAX_RESULT_CHARS,
  DEFAULT_WALL_CLOCK_MS,
  WorkflowLimitError,
  WorkflowTimeoutError,
  addUsage,
  emptyUsage,
  workflowConfigFromEnv,
  type WorkflowAgentRecord,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowAgentRunner,
  type WorkflowConfig,
  type WorkflowEvent,
  type WorkflowPhaseStat,
  type WorkflowRunResult,
  type WorkflowUsage,
} from "./workflow-types";
import { extractJson, validateJsonSchema } from "./agent-schema";
import { parseWorkflowMeta, runWorkflowScript, type WorkflowMeta } from "./workflow-sandbox";
import { createSlotPool, type SlotPool } from "./workflow-slots";
import { createResumableWallClock } from "./workflow-clock";
import { agentKey, fingerprintOf, type WorkflowReplay } from "./workflow-replay";

export interface WorkflowRuntimeOptions {
  runAgent: WorkflowAgentRunner;
  config?: WorkflowConfig;
  onEvent?: (event: WorkflowEvent) => void;
  now?: () => number;
  /** Injected in tests so a bad script and a slow script are both testable. */
  runScript?: typeof runWorkflowScript;
  /** Values the script reads as `args`. */
  args?: unknown;
  /** Internal: nesting level, 1 for the run the user started. */
  depth?: number;
  /** Internal: shared across nested runs so the cap is one cap, not two. */
  shared?: SharedState;
  /**
   * A slot pool shared with the rest of the process, so a background workflow
   * and a chat subagent cannot add up to twice the concurrency limit.
   */
  slots?: SlotPool;
  /** Saved answers from an earlier attempt, when this run is a resume. */
  replay?: WorkflowReplay;
  /** Internal: this run's scope inside its parent, so call keys stay stable. */
  scope?: string;
  /**
   * The moment the SCRIPT should see as "now". A resumed run passes the original
   * run's start time, so the script's own decisions repeat exactly.
   */
  scriptNow?: number;
}

/** State that must be shared by a run and its children, never copied. */
export interface SharedState {
  started: number;
  agents: WorkflowAgentRecord[];
  usage: WorkflowUsage;
  truncated: boolean;
  semaphore: SlotPool;
  controller: AbortController;
  /** Agents answered from the journal, and the tokens they had already spent. */
  replayed: number;
  replayedUsage: WorkflowUsage;
  /** Set while the user has paused the run. New agents wait here. */
  paused: boolean;
  /** Calls waiting for a resume, woken together. */
  pauseWaiters: Array<() => void>;
}

/** Depth-limited JSON clone, so a script cannot hand back an object graph. */
export function cloneResult(value: unknown, maxChars: number): { ok: true; value: unknown } | { ok: false; error: string } {
  const seen = new WeakSet<object>();
  const walk = (input: unknown, depth: number): unknown => {
    if (input === null || typeof input !== "object") {
      if (typeof input === "function") return undefined;
      if (typeof input === "bigint") return String(input);
      return input;
    }
    if (depth > 12) return "[depth limit]";
    const asObject = input as object;
    if (seen.has(asObject)) return "[circular]";
    seen.add(asObject);
    if (Array.isArray(input)) return input.slice(0, 5000).map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    let count = 0;
    for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
      if (count >= 2000) {
        out["…"] = "[key limit]";
        break;
      }
      out[key] = walk(item, depth + 1);
      count += 1;
    }
    return out;
  };
  try {
    const cloned = walk(value, 0);
    const text = JSON.stringify(cloned) ?? "";
    if (text.length > maxChars) return { ok: false, error: `workflow result is too large (${text.length} chars)` };
    return { ok: true, value: cloned === undefined ? null : cloned };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/** How much of an agent's answer travels in an event (the journal caps further). */
const EVENT_TEXT_LIMIT = 4000;

function capEventText(text: unknown): string | undefined {
  if (typeof text !== "string" || text === "") return undefined;
  return text.length <= EVENT_TEXT_LIMIT ? text : text.slice(0, EVENT_TEXT_LIMIT);
}

export class WorkflowRuntime {
  readonly config: WorkflowConfig;
  private readonly runAgent: WorkflowAgentRunner;
  private readonly onEvent?: (event: WorkflowEvent) => void;
  private readonly now: () => number;
  private readonly runScript: typeof runWorkflowScript;
  private readonly shared: SharedState;
  private readonly depth: number;
  private readonly args: unknown;
  private readonly replay?: WorkflowReplay;
  private readonly scope: string;
  private readonly scriptNow?: number;
  /** Calls started in this scope, so a replay asks for the same position. */
  private scopeCalls = 0;
  /** Children get their own scope; this count keeps two calls apart. */
  private childCalls = 0;
  private readonly wallClock: ReturnType<typeof createResumableWallClock>;

  private readonly phases: string[] = [];
  private readonly logs: string[] = [];
  private readonly phaseTiming = new Map<string, { agents: number; failed: number; tokens: number; durationMs: number }>();
  private startedAt = 0;
  private currentPhase: string | undefined;

  constructor(options: WorkflowRuntimeOptions) {
    this.config = options.config ?? workflowConfigFromEnv();
    this.runAgent = options.runAgent;
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
    this.runScript = options.runScript ?? runWorkflowScript;
    this.depth = options.depth ?? 1;
    this.args = options.args;
    this.replay = options.replay;
    this.scope = options.scope ?? "";
    this.scriptNow = options.scriptNow;
    this.shared =
      options.shared ?? {
        started: 0,
        agents: [],
        usage: emptyUsage(),
        truncated: false,
        semaphore: options.slots ?? createSlotPool(this.config.concurrency),
        controller: new AbortController(),
        replayed: 0,
        replayedUsage: emptyUsage(),
        paused: false,
        pauseWaiters: [],
      };
    this.wallClock = createResumableWallClock(this.config.wallClockMs, { now: () => this.now() });
  }

  /**
   * Pause: stop starting new agents. The ones already talking to the model are
   * allowed to finish, because killing them would throw away tokens already paid
   * for. The wall clock stops too: a paused run must not burn its ten minutes.
   */
  pause(): void {
    if (this.shared.paused) return;
    this.shared.paused = true;
    this.wallClock.pause();
    this.emit({ type: "paused", at: this.now(), depth: this.depth });
  }

  /** Resume a paused run. Nothing is replayed: it simply carries on. */
  resumeLive(): void {
    if (!this.shared.paused) return;
    this.shared.paused = false;
    const waiters = this.shared.pauseWaiters.splice(0);
    for (const wake of waiters) wake();
    this.wallClock.start(() => this.shared.controller.abort());
    this.emit({ type: "resumed", at: this.now(), depth: this.depth });
  }

  get paused(): boolean {
    return this.shared.paused;
  }

  /** Block here while paused. Every agent call passes through this gate. */
  private async waitWhilePaused(): Promise<void> {
    if (!this.shared.paused) return;
    await new Promise<void>((resolve) => this.shared.pauseWaiters.push(resolve));
  }

  get signal(): AbortSignal {
    return this.shared.controller.signal;
  }

  private emit(event: WorkflowEvent): void {
    try {
      this.onEvent?.(event);
    } catch {
      // A listener that throws must not kill the run.
    }
  }

  phase(name: unknown): void {
    const label = typeof name === "string" ? name.trim().slice(0, 120) : String(name).slice(0, 120);
    if (label === "") return;
    this.currentPhase = label;
    if (!this.phases.includes(label)) this.phases.push(label);
    this.emit({ type: "phase", at: this.now(), name: label, depth: this.depth });
  }

  log(message: unknown): void {
    const text = typeof message === "string" ? message : JSON.stringify(message);
    if (!text) return;
    const line = text.slice(0, 2000);
    if (this.logs.length >= this.config.maxLogLines) {
      if (!this.shared.truncated) {
        this.shared.truncated = true;
        const note = `[log limit reached at ${this.config.maxLogLines} lines; more output was dropped]`;
        this.logs.push(note);
        this.emit({ type: "log", at: this.now(), message: note, depth: this.depth });
      }
      return;
    }
    this.logs.push(line);
    this.emit({ type: "log", at: this.now(), message: line, depth: this.depth });
  }

  /** Take one agent from the ONE budget shared by every nested run. */
  private reserve(): void {
    if (this.shared.started >= this.config.maxAgents) {
      throw new WorkflowLimitError(
        `agent budget exhausted: this workflow already started ${this.config.maxAgents} agents (QRONOS_WORKFLOW_MAX_AGENTS)`,
      );
    }
    this.shared.started += 1;
  }

  async agent(
    prompt: unknown,
    options: { label?: string; schema?: unknown; agent?: string; model?: string } = {},
  ): Promise<WorkflowAgentResult> {
    const text = typeof prompt === "string" ? prompt : String(prompt);
    if (text.trim() === "") return { ok: false, text: "", error: "empty prompt" };

    // The position of this call inside its scope. A replay asks for the same
    // position again, which is why the counter moves before anything is awaited.
    const index = this.scopeCalls;
    this.scopeCalls += 1;
    const id = agentKey(this.scope, index);
    const label = (options.label ?? text).trim().slice(0, 80).replace(/\n/g, " ");
    const request: WorkflowAgentRequest = {
      prompt: text,
      label,
      schema: options.schema,
      agentType: options.agent,
      model: typeof options.model === "string" && options.model.trim() !== "" ? options.model.trim() : undefined,
    };
    const fingerprint = fingerprintOf({ prompt: text, agent: request.agentType, model: request.model });

    // A saved answer costs nothing: no slot, no model, no budget. It must still
    // pass the same schema check, because the schema may have changed.
    const saved = this.replay?.lookup(this.scope, index, {
      prompt: text,
      agent: request.agentType,
      model: request.model,
    });
    if (saved?.hit) {
      const replayed = this.checkSchema(saved.result, options.schema);
      this.emit({ type: "agent_start", at: this.now(), id, label, phase: this.currentPhase, depth: this.depth });
      this.record({ id, label, index, fingerprint, checked: replayed, durationMs: 0, replayed: true });
      return replayed;
    }

    // A paused run starts nothing new. Waiting here, before the budget and the
    // slot, means a paused run holds no resources.
    await this.waitWhilePaused();
    if (this.shared.controller.signal.aborted) {
      return { ok: false, text: "", error: "the workflow was stopped before this agent started" };
    }

    this.reserve();
    this.emit({
      type: "agent_start",
      at: this.now(),
      id,
      label,
      phase: this.currentPhase,
      depth: this.depth,
    });

    await this.shared.semaphore.acquire();
    const startedAt = this.now();
    try {
      let result: WorkflowAgentResult;
      try {
        result = await this.runAgent(request, this.shared.controller.signal);
      } catch (error) {
        result = {
          ok: false,
          text: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const checked = this.checkSchema(result, options.schema);
      this.record({ id, label, index, fingerprint, checked, durationMs: this.now() - startedAt, replayed: false });
      return checked;
    } finally {
      this.shared.semaphore.release();
    }
  }

  /** Book one finished agent: the record, the totals, the phase and the event. */
  private record(entry: {
    id: string;
    label: string;
    index: number;
    fingerprint: string;
    checked: WorkflowAgentResult;
    durationMs: number;
    replayed: boolean;
  }): void {
    const { id, label, checked, durationMs, replayed, index, fingerprint } = entry;
    const record: WorkflowAgentRecord = {
      id,
      label,
      ok: checked.ok,
      error: checked.error,
      phase: this.currentPhase,
      durationMs,
      usage: checked.usage,
      depth: this.depth,
      replayed,
    };
    this.shared.agents.push(record);
    if (replayed) this.shared.replayed += 1;
    else this.shared.usage = addUsage(this.shared.usage, checked.usage);
    if (replayed) this.shared.replayedUsage = addUsage(this.shared.replayedUsage, checked.usage);
    this.bumpPhase(record);
    this.emit({
      type: "agent_end",
      at: this.now(),
      id,
      label,
      ok: checked.ok,
      error: checked.error,
      phase: this.currentPhase,
      durationMs,
      usage: checked.usage,
      depth: this.depth,
      text: capEventText(checked.text),
      replayed,
      scope: this.scope,
      index,
      fingerprint,
    });
  }

  private bumpPhase(record: WorkflowAgentRecord): void {
    if (!record.phase) return;
    const entry = this.phaseTiming.get(record.phase) ?? { agents: 0, failed: 0, tokens: 0, durationMs: 0 };
    entry.agents += 1;
    if (!record.ok) entry.failed += 1;
    // A replayed agent spent nothing this time, so the phase totals still add up
    // to the run's token total. Its old cost is reported separately.
    entry.tokens += record.replayed ? 0 : record.usage?.total ?? 0;
    entry.durationMs += record.durationMs;
    this.phaseTiming.set(record.phase, entry);
  }

  /** Validate the schema here, so a script cannot receive unchecked data. */
  private checkSchema(result: WorkflowAgentResult, schema: unknown): WorkflowAgentResult {
    if (schema === undefined || schema === null) return result;
    if (!result.ok) return result;
    const data = result.data ?? extractJson(result.text).value;
    const verdict = validateJsonSchema(data, schema);
    if (verdict.ok) return { ...result, data };
    const detail = verdict.issues
      .slice(0, 3)
      .map((issue) => `${issue.path || "value"} ${issue.message}`)
      .join("; ");
    return { ok: false, text: result.text, data, error: `schema not satisfied: ${detail}` };
  }

  /** Run a list of promises or thunks with the shared concurrency limit. */
  async parallel(items: unknown): Promise<unknown[]> {
    if (!Array.isArray(items)) throw new WorkflowLimitError("parallel() needs an array");
    const tasks = items.map((item) => (typeof item === "function" ? (item as () => unknown) : () => item));
    const results = new Array<unknown>(tasks.length);
    await Promise.all(
      tasks.map(async (task, index) => {
        try {
          results[index] = await task();
        } catch (error) {
          results[index] = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    return results;
  }

  /** One task per item, concurrency-limited, order preserved. */
  async pipeline(items: unknown, fn: unknown): Promise<unknown[]> {
    if (!Array.isArray(items)) throw new WorkflowLimitError("pipeline() needs an array");
    if (typeof fn !== "function") throw new WorkflowLimitError("pipeline() needs a function");
    const call = fn as (item: unknown, index: number) => unknown;
    return this.parallel(items.map((item, index) => () => call(item, index)));
  }

  /**
   * A nested workflow. One child level, as in Claude Code, and the child shares
   * this run's budget, concurrency and abort signal, so nesting cannot double a
   * cost or escape a stop.
   */
  async nested(script: unknown): Promise<unknown> {
    if (typeof script !== "string") throw new WorkflowLimitError("workflow() needs a script string");
    if (this.depth >= this.config.maxDepth) {
      throw new WorkflowLimitError(
        `workflow() cannot nest deeper than ${this.config.maxDepth} levels (QRONOS_WORKFLOW_MAX_DEPTH)`,
      );
    }
    const child = new WorkflowRuntime({
      runAgent: this.runAgent,
      config: this.config,
      onEvent: this.onEvent,
      now: this.now,
      runScript: this.runScript,
      args: this.args,
      depth: this.depth + 1,
      shared: this.shared,
      replay: this.replay,
      scriptNow: this.scriptNow ?? this.startedAt,
      // A child gets its own scope, so its call positions are separate from the
      // parent's and stay stable across a replay.
      scope: `${this.scope}w${this.childCalls}/`,
    });
    this.childCalls += 1;
    // The child inherits the phases named so far, so its agents are attributed
    // to the phase the parent was in when it called workflow().
    if (this.currentPhase) child.phase(this.currentPhase);
    return child.run(script).then((result) => {
      for (const name of result.phases) if (!this.phases.includes(name)) this.phases.push(name);
      for (const stat of result.phaseStats ?? []) {
        const entry = this.phaseTiming.get(stat.name) ?? { agents: 0, failed: 0, tokens: 0, durationMs: 0 };
        this.phaseTiming.set(stat.name, {
          agents: entry.agents + stat.agents,
          failed: entry.failed + stat.failed,
          tokens: entry.tokens + stat.tokens,
          durationMs: entry.durationMs + stat.durationMs,
        });
      }
      this.logs.push(...result.logs.filter((line) => !this.logs.includes(line)));
      if (!result.ok) throw new Error(result.error ?? "nested workflow failed");
      return result.value;
    });
  }

  /**
   * Run the script and give back one settled result.
   *
   * Every failure mode (bad syntax, a thrown error, the wall clock, the agent
   * cap) becomes `ok: false` with a reason, because the caller is a chat turn
   * that must keep working.
   */
  async run(script: string): Promise<WorkflowRunResult & { meta: WorkflowMeta }> {
    this.startedAt = this.now();
    this.emit({ type: "run_start", at: this.startedAt, scriptChars: script.length, depth: this.depth });
    const meta = parseWorkflowMeta(script);
    const topLevel = this.depth === 1;

    let timedOut = false;
    // The wall clock covers the top-level run only: a child runs inside it. It is
    // a pausable countdown, so a run paused for an hour keeps its full budget.
    const timeout = topLevel
      ? new Promise<never>((_, reject) => {
          this.wallClock.start(() => {
            timedOut = true;
            this.shared.controller.abort();
            reject(new WorkflowTimeoutError(this.config.wallClockMs));
          });
        })
      : new Promise<never>(() => {});

    let value: unknown;
    let error: string | undefined;
    try {
      value = await Promise.race([
        this.runScript(script, this.helpers(), { now: this.scriptNow ?? this.startedAt }),
        timeout,
      ]);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      this.wallClock.stop();
    }

    let finalValue: unknown;
    if (error === undefined) {
      const cloned = cloneResult(value, this.config.maxResultChars);
      if (cloned.ok) finalValue = cloned.value;
      else error = cloned.error;
    }

    const durationMs = this.now() - this.startedAt;
    const phaseStats: WorkflowPhaseStat[] = [...this.phaseTiming.entries()].map(([name, stat]) => ({
      name,
      agents: stat.agents,
      failed: stat.failed,
      tokens: stat.tokens,
      durationMs: stat.durationMs,
    }));
    const result: WorkflowRunResult = {
      ok: error === undefined,
      value: finalValue,
      error,
      agents: this.shared.agents,
      phases: this.phases,
      phaseStats,
      logs: this.logs,
      durationMs,
      truncated: this.shared.truncated,
      tokens: topLevel ? { ...this.shared.usage } : addUsage(this.shared.usage, undefined),
      replayed: this.shared.replayed,
      replayedTokens: topLevel ? { ...this.shared.replayedUsage } : undefined,
    };
    this.emit({
      type: "run_end",
      at: this.now(),
      ok: result.ok,
      agents: this.shared.agents.length,
      durationMs,
      tokens: result.tokens.total,
      error: timedOut ? "wall clock" : error,
      depth: this.depth,
    });
    return { ...result, meta };
  }

  /** The helper bag handed to the sandbox. Nothing else is reachable from it. */
  private helpers() {
    return {
      agent: (prompt: unknown, options?: { label?: string; schema?: unknown; agent?: string; model?: string }) =>
        this.agent(prompt, options),
      parallel: (items: unknown) => this.parallel(items),
      pipeline: (items: unknown, fn: unknown) => this.pipeline(items, fn),
      phase: (name: unknown) => this.phase(name),
      log: (message: unknown) => this.log(message),
      workflow: (child: unknown) => this.nested(child),
      args: this.args,
      budget: {
        maxAgents: this.config.maxAgents,
        used: () => this.shared.started,
      },
    };
  }

  abort(): void {
    this.shared.controller.abort();
  }
}

export { DEFAULT_WALL_CLOCK_MS, DEFAULT_MAX_LOG_LINES, DEFAULT_MAX_RESULT_CHARS };
