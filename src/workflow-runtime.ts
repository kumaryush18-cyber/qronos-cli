// The workflow runtime: phases, fan-out, caps, schema, and one result.
//
// A run is a script plus a bag of helpers. Everything a script can do
// (`agent`, `parallel`, `pipeline`) goes through this class, which is why the
// caps, the schema check and the event log cannot be bypassed by the script.
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
  workflowConfigFromEnv,
  type WorkflowAgentRequest,
  type WorkflowAgentResult,
  type WorkflowAgentRunner,
  type WorkflowConfig,
  type WorkflowEvent,
  type WorkflowRunResult,
} from "./workflow-types";
import { extractJson, validateJsonSchema } from "./agent-schema";
import { parseWorkflowMeta, runWorkflowScript, type WorkflowMeta } from "./workflow-sandbox";

export interface WorkflowRuntimeOptions {
  runAgent: WorkflowAgentRunner;
  config?: WorkflowConfig;
  onEvent?: (event: WorkflowEvent) => void;
  now?: () => number;
  /** Injected in tests so a bad script and a slow script are both testable. */
  runScript?: typeof runWorkflowScript;
}

/** A simple counting semaphore: at most `limit` holders at a time. */
function createSemaphore(limit: number) {
  let active = 0;
  const waiting: Array<() => void> = [];
  return {
    async acquire(): Promise<void> {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise<void>((resolve) => waiting.push(resolve));
      active += 1;
    },
    release(): void {
      active -= 1;
      const next = waiting.shift();
      if (next) next();
    },
    get active(): number {
      return active;
    },
  };
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

export class WorkflowRuntime {
  readonly config: WorkflowConfig;
  private readonly runAgent: WorkflowAgentRunner;
  private readonly onEvent?: (event: WorkflowEvent) => void;
  private readonly now: () => number;
  private readonly runScript: typeof runWorkflowScript;
  private readonly semaphore: ReturnType<typeof createSemaphore>;
  private readonly controller = new AbortController();

  private agentsStarted = 0;
  private readonly agents: WorkflowRunResult["agents"] = [];
  private readonly phases: string[] = [];
  private readonly logs: string[] = [];
  private startedAt = 0;
  private currentPhase: string | undefined;
  private truncated = false;

  constructor(options: WorkflowRuntimeOptions) {
    this.config = options.config ?? workflowConfigFromEnv();
    this.runAgent = options.runAgent;
    this.onEvent = options.onEvent;
    this.now = options.now ?? Date.now;
    this.runScript = options.runScript ?? runWorkflowScript;
    this.semaphore = createSemaphore(this.config.concurrency);
  }

  get signal(): AbortSignal {
    return this.controller.signal;
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
    this.phases.push(label);
    this.emit({ type: "phase", at: this.now(), name: label });
  }

  log(message: unknown): void {
    const text = typeof message === "string" ? message : JSON.stringify(message);
    if (!text) return;
    const line = text.slice(0, 2000);
    if (this.logs.length >= this.config.maxLogLines) {
      if (!this.truncated) {
        this.truncated = true;
        const note = `[log limit reached at ${this.config.maxLogLines} lines; more output was dropped]`;
        this.logs.push(note);
        this.emit({ type: "log", at: this.now(), message: note });
      }
      return;
    }
    this.logs.push(line);
    this.emit({ type: "log", at: this.now(), message: line });
  }

  /** Reserve one agent slot, or explain why the run cannot continue. */
  private reserve(): string {
    if (this.agentsStarted >= this.config.maxAgents) {
      throw new WorkflowLimitError(
        `agent budget exhausted: this workflow already started ${this.config.maxAgents} agents (QRONOS_WORKFLOW_MAX_AGENTS)`,
      );
    }
    this.agentsStarted += 1;
    return `wf-${this.agentsStarted}`;
  }

  async agent(prompt: unknown, options: { label?: string; schema?: unknown; agent?: string } = {}): Promise<WorkflowAgentResult> {
    const text = typeof prompt === "string" ? prompt : String(prompt);
    if (text.trim() === "") return { ok: false, text: "", error: "empty prompt" };
    const id = this.reserve();
    const label = (options.label ?? text).trim().slice(0, 80).replace(/\n/g, " ");
    this.emit({ type: "agent_start", at: this.now(), id, label });

    await this.semaphore.acquire();
    try {
      const request: WorkflowAgentRequest = {
        prompt: text,
        label,
        schema: options.schema,
        agentType: options.agent,
      };
      let result: WorkflowAgentResult;
      try {
        result = await this.runAgent(request, this.controller.signal);
      } catch (error) {
        result = {
          ok: false,
          text: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
      const checked = this.checkSchema(result, options.schema);
      this.agents.push({ id, label, ok: checked.ok, error: checked.error });
      this.emit({
        type: "agent_end",
        at: this.now(),
        id,
        label,
        ok: checked.ok,
        error: checked.error,
      });
      return checked;
    } finally {
      this.semaphore.release();
    }
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
    const tasks = items.map((item, index) =>
      typeof item === "function" ? (item as () => unknown) : () => item,
    );
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
   * Run the script and give back one settled result.
   *
   * Every failure mode (bad syntax, a thrown error, the wall clock, the agent
   * cap) becomes `ok: false` with a reason, because the caller is a chat turn
   * that must keep working.
   */
  async run(script: string): Promise<WorkflowRunResult & { meta: WorkflowMeta }> {
    this.startedAt = this.now();
    this.emit({ type: "run_start", at: this.startedAt, scriptChars: script.length });
    const meta = parseWorkflowMeta(script);

    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        this.controller.abort();
        reject(new WorkflowTimeoutError(this.config.wallClockMs));
      }, this.config.wallClockMs);
      if (typeof timer === "object" && "unref" in timer) (timer as { unref(): void }).unref();
    });

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
    const result: WorkflowRunResult = {
      ok: error === undefined,
      value: finalValue,
      error,
      agents: this.agents,
      phases: this.phases,
      logs: this.logs,
      durationMs,
      truncated: this.truncated,
    };
    this.emit({
      type: "run_end",
      at: this.now(),
      ok: result.ok,
      agents: this.agents.length,
      durationMs,
      error: timedOut ? "wall clock" : error,
    });
    return { ...result, meta };
  }

  /** The helper bag handed to the sandbox. Nothing else is reachable from it. */
  private helpers() {
    return {
      agent: (prompt: unknown, options?: { label?: string; schema?: unknown; agent?: string }) =>
        this.agent(prompt, options),
      parallel: (items: unknown) => this.parallel(items),
      pipeline: (items: unknown, fn: unknown) => this.pipeline(items, fn),
      phase: (name: unknown) => this.phase(name),
      log: (message: unknown) => this.log(message),
    };
  }

  abort(): void {
    this.controller.abort();
  }
}

export { DEFAULT_WALL_CLOCK_MS, DEFAULT_MAX_LOG_LINES, DEFAULT_MAX_RESULT_CHARS };
