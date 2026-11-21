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
}

/** State that must be shared by a run and its children, never copied. */
export interface SharedState {
  started: number;
  agents: WorkflowAgentRecord[];
  usage: WorkflowUsage;
  truncated: boolean;
  semaphore: SlotPool;
  controller: AbortController;
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
    this.shared =
      options.shared ?? {
        started: 0,
        agents: [],
        usage: emptyUsage(),
        truncated: false,
        semaphore: options.slots ?? createSlotPool(this.config.concurrency),
        controller: new AbortController(),
      };
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

  /** Reserve one agent slot from the ONE budget shared by every nested run. */
  private reserve(): string {
    if (this.shared.started >= this.config.maxAgents) {
      throw new WorkflowLimitError(
        `agent budget exhausted: this workflow already started ${this.config.maxAgents} agents (QRONOS_WORKFLOW_MAX_AGENTS)`,
      );
    }
    this.shared.started += 1;
    return `wf-${this.shared.started}`;
  }

  async agent(
    prompt: unknown,
    options: { label?: string; schema?: unknown; agent?: string; model?: string } = {},
  ): Promise<WorkflowAgentResult> {
    const text = typeof prompt === "string" ? prompt : String(prompt);
    if (text.trim() === "") return { ok: false, text: "", error: "empty prompt" };
    const id = this.reserve();
    const label = (options.label ?? text).trim().slice(0, 80).replace(/\n/g, " ");
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
      const request: WorkflowAgentRequest = {
        prompt: text,
        label,
        schema: options.schema,
        agentType: options.agent,
        model: typeof options.model === "string" && options.model.trim() !== "" ? options.model.trim() : undefined,
      };
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
      const durationMs = this.now() - startedAt;
      const record: WorkflowAgentRecord = {
        id,
        label,
        ok: checked.ok,
        error: checked.error,
        phase: this.currentPhase,
        durationMs,
        usage: checked.usage,
        depth: this.depth,
      };
      this.shared.agents.push(record);
      this.shared.usage = addUsage(this.shared.usage, checked.usage);
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
      });
      return checked;
    } finally {
      this.shared.semaphore.release();
    }
  }

  private bumpPhase(record: WorkflowAgentRecord): void {
    if (!record.phase) return;
    const entry = this.phaseTiming.get(record.phase) ?? { agents: 0, failed: 0, tokens: 0, durationMs: 0 };
    entry.agents += 1;
    if (!record.ok) entry.failed += 1;
    entry.tokens += record.usage?.total ?? 0;
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
    });
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

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    // The wall clock covers the top-level run only: a child runs inside it.
    const timeout = topLevel
      ? new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            this.shared.controller.abort();
            reject(new WorkflowTimeoutError(this.config.wallClockMs));
          }, this.config.wallClockMs);
          if (typeof timer === "object" && "unref" in timer) (timer as { unref(): void }).unref();
        })
      : new Promise<never>(() => {});

    let value: unknown;
    let error: string | undefined;
    try {
      value = await Promise.race([this.runScript(script, this.helpers()), timeout]);
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    } finally {
      if (timer) clearTimeout(timer);
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
