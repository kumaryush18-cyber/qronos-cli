// Background workflow jobs.
//
// Claude Code's launch is non-blocking: the tool returns a task id at once and
// the run keeps going while you talk. This file is that behaviour for Qronos.
//
// The promise is small and strict:
//   - `launch()` returns a job immediately, before any model call;
//   - the job's state, agents, phases and tokens are readable at any time;
//   - every step is written to the journal, so a crash loses the last step only;
//   - `cancel()` stops scheduling new agents and aborts the ones in flight;
//   - the result is delivered once, by the caller, never twice.
import { homedir } from "node:os";
import { WorkflowRuntime } from "./workflow-runtime";
import { WorkflowJournal, journalDir, journalPath, pruneJournals } from "./workflow-journal";
import { sharedSlotPool } from "./workflow-slots";
import {
  addUsage,
  emptyUsage,
  workflowConfigFromEnv,
  type WorkflowAgentRecord,
  type WorkflowAgentRunner,
  type WorkflowConfig,
  type WorkflowEvent,
  type WorkflowPhaseStat,
  type WorkflowRunResult,
  type WorkflowUsage,
} from "./workflow-types";

export type WorkflowJobState = "queued" | "running" | "done" | "failed" | "cancelled";

export interface WorkflowJob {
  id: string;
  name: string;
  state: WorkflowJobState;
  script: string;
  startedAt: number;
  finishedAt?: number;
  /** The run's own result, once it settled. */
  result?: WorkflowRunResult;
  error?: string;
  /** Live counters, kept up to date as events arrive. */
  running: number;
  done: number;
  failed: number;
  tokens: WorkflowUsage;
  phases: string[];
  phaseStats: WorkflowPhaseStat[];
  agents: WorkflowAgentRecord[];
  /** The last few events, for a panel that cannot keep its own history. */
  recent: WorkflowEvent[];
  journalPath?: string;
  /** Resolves when the job settles. Handy in tests, and only there. */
  settled: Promise<WorkflowJob>;
  /** Internal: set once settled, so a job settles exactly once. */
  settledState?: boolean;
  settledResolve?: (job: WorkflowJob) => void;
}

export interface LaunchWorkflowInput {
  script: string;
  name?: string;
  args?: unknown;
}

export interface WorkflowJobManagerOptions {
  runAgent: WorkflowAgentRunner;
  config?: WorkflowConfig;
  /** Where journals live. A job with no agent dir runs without a journal. */
  agentDir?: string;
  now?: () => number;
  /** Called exactly once per job, when it settles. */
  onSettle?: (job: WorkflowJob) => void;
  /** For tests: run the job body on the current tick. */
  startImmediately?: boolean;
}

const RECENT_LIMIT = 60;

export class WorkflowJobManager {
  private readonly jobs = new Map<string, WorkflowJob>();
  private readonly runtimes = new Map<string, WorkflowRuntime>();
  private readonly options: WorkflowJobManagerOptions;
  private readonly config: WorkflowConfig;
  private readonly now: () => number;
  private sequence = 0;

  constructor(options: WorkflowJobManagerOptions) {
    this.options = options;
    this.config = options.config ?? workflowConfigFromEnv();
    this.now = options.now ?? Date.now;
  }

  /** Create a job and start it. Returns before the first agent is spawned. */
  launch(input: LaunchWorkflowInput): WorkflowJob {
    const id = this.nextId();
    const name = (input.name && input.name.trim() !== "" ? input.name : "workflow").slice(0, 60);
    const job: WorkflowJob = {
      id,
      name,
      state: "queued",
      script: input.script,
      startedAt: this.now(),
      running: 0,
      done: 0,
      failed: 0,
      tokens: emptyUsage(),
      phases: [],
      phaseStats: [],
      agents: [],
      recent: [],
      settled: Promise.resolve() as unknown as Promise<WorkflowJob>,
    };
    job.settled = new Promise<WorkflowJob>((resolve) => {
      job.settledResolve = resolve;
    });
    this.jobs.set(id, job);

    const journal = this.makeJournal(id);
    job.journalPath = journal?.path;
    journal?.append({
      kind: "run_start",
      at: job.startedAt,
      id,
      name,
      script: input.script,
      maxAgents: this.config.maxAgents,
      wallClockMs: this.config.wallClockMs,
    });

    const runtime = new WorkflowRuntime({
      runAgent: this.options.runAgent,
      config: this.config,
      now: this.now,
      args: input.args,
      slots: sharedSlotPool(),
      onEvent: (event) => {
        this.applyEvent(job, event, journal);
      },
    });
    this.runtimes.set(id, runtime);

    const start = () => {
      job.state = "running";
      void runtime
        .run(input.script)
        .then((result) => {
          if (job.state === "cancelled") return;
          job.result = result;
          job.state = result.ok ? "done" : "failed";
          job.error = result.error;
          journal?.append({
            kind: "run_end",
            at: this.now(),
            ok: result.ok,
            error: result.error,
            tokens: result.tokens,
            durationMs: result.durationMs,
          });
        })
        .catch((error: unknown) => {
          job.state = "failed";
          job.error = error instanceof Error ? error.message : String(error);
        })
        .finally(() => {
          job.finishedAt = this.now();
          job.running = 0;
          this.runtimes.delete(id);
          this.settle(job);
        });
    };

    // A job must not start inside the tool call: the tool has to return first.
    if (this.options.startImmediately) start();
    else {
      const timer = setTimeout(start, 0);
      if (typeof timer === "object" && "unref" in timer) (timer as { unref(): void }).unref();
    }
    return job;
  }

  get(id: string): WorkflowJob | undefined {
    return this.jobs.get(id);
  }

  list(): WorkflowJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  /** Running or queued jobs only. */
  active(): WorkflowJob[] {
    return this.list().filter((job) => job.state === "queued" || job.state === "running");
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state !== "running" && job.state !== "queued") return false;
    job.state = "cancelled";
    job.error = "cancelled by the user";
    this.runtimes.get(id)?.abort();
    this.runtimes.delete(id);
    job.finishedAt = this.now();
    this.makeJournal(id)?.append({
      kind: "run_end",
      at: this.now(),
      ok: false,
      error: "cancelled by the user",
      tokens: job.tokens,
      durationMs: this.now() - job.startedAt,
    });
    this.settle(job);
    return true;
  }

  /** Forget settled jobs beyond `keep`, so a long session cannot grow forever. */
  prune(keep = 20): number {
    const settled = this.list().filter((job) => !this.active().includes(job));
    let removed = 0;
    for (const job of settled.slice(keep)) {
      this.jobs.delete(job.id);
      removed += 1;
    }
    if (this.options.agentDir) pruneJournals(journalDir(this.options.agentDir), this.now());
    return removed;
  }

  private settle(job: WorkflowJob): void {
    if (job.settledState) return;
    job.settledState = true;
    try {
      this.options.onSettle?.(job);
    } catch {
      // A listener that throws must not leave the job half settled.
    }
    job.settledResolve?.(job);
  }

  private makeJournal(id: string): WorkflowJournal | undefined {
    const dir = this.options.agentDir ?? this.ensureAgentDir();
    if (!dir) return undefined;
    return new WorkflowJournal(journalPath(dir, id));
  }

  private ensureAgentDir(): string {
    // A job started outside a session (a test, a script) still gets a journal,
    // in the same place the CLI keeps its agent state.
    try {
      return this.options.agentDir ?? `${homedir()}/.qronos/agent`;
    } catch {
      return "";
    }
  }

  private applyEvent(job: WorkflowJob, event: WorkflowEvent, journal?: WorkflowJournal): void {
    job.recent.push(event);
    if (job.recent.length > RECENT_LIMIT) job.recent.splice(0, job.recent.length - RECENT_LIMIT);

    switch (event.type) {
      case "phase":
        if (!job.phases.includes(event.name)) job.phases.push(event.name);
        journal?.append({ kind: "phase", at: event.at, name: event.name });
        break;
      case "log":
        journal?.append({ kind: "log", at: event.at, message: event.message });
        break;
      case "agent_start":
        job.running += 1;
        journal?.append({ kind: "agent_start", at: event.at, id: event.id, label: event.label, phase: event.phase });
        break;
      case "agent_end": {
        job.running = Math.max(0, job.running - 1);
        job.done += 1;
        if (!event.ok) job.failed += 1;
        job.tokens = addUsage(job.tokens, event.usage);
        const record: WorkflowAgentRecord = {
          id: event.id,
          label: event.label,
          ok: event.ok,
          error: event.error,
          phase: event.phase,
          durationMs: event.durationMs,
          usage: event.usage,
          depth: event.depth,
        };
        job.agents.push(record);
        journal?.appendAgentEnd({
          kind: "agent_end",
          at: event.at,
          id: event.id,
          ok: event.ok,
          error: event.error,
          usage: event.usage,
          durationMs: event.durationMs,
          text: (event as { text?: string }).text,
        });
        break;
      }
      case "run_end":
        job.tokens = addUsage(job.tokens, undefined);
        break;
      default:
        break;
    }
  }

  private nextId(): string {
    this.sequence += 1;
    const stamp = this.startedBase();
    return `wf_${stamp}${String(this.sequence).padStart(2, "0")}`;
  }

  /** Short, readable, and stable inside one process. */
  private startedBase(): string {
    const now = this.now();
    const base = Number.isFinite(now) ? now : Date.now();
    return base.toString(36).slice(-6);
  }
}
