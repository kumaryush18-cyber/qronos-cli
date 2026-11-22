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
import {
  WorkflowJournal,
  journalDir,
  journalPath,
  listSavedRuns,
  pruneJournals,
  type JournalEntry,
  type SavedRun,
} from "./workflow-journal";
import { WorkflowReplay, replayRecordsFromJournal } from "./workflow-replay";
import { parseWorkflowMeta } from "./workflow-sandbox";
import { sharedSlotPool } from "./workflow-slots";
import {
  MAX_ACTIVITY_ROWS,
  addUsage,
  emptyUsage,
  workflowConfigFromEnv,
  type WorkflowAgentActivity,
  type WorkflowAgentRecord,
  type WorkflowAgentRunner,
  type WorkflowConfig,
  type WorkflowEvent,
  type WorkflowPhaseStat,
  type WorkflowRunResult,
  type WorkflowToolDecision,
  type WorkflowToolFacts,
  type WorkflowUsage,
} from "./workflow-types";

/**
 * An agent that is still working, as the panel sees it.
 *
 * It lives in a map, not in the event window: sixteen agents making forty tool
 * calls each would push every `agent_start` out of a sixty-line window, and the
 * panel would go blank exactly while the run is busiest.
 */
export interface WorkflowLiveAgent {
  id: string;
  label: string;
  phase?: string;
  /** Redacted, capped task text. */
  prompt?: string;
  model?: string;
  startedAt: number;
  activity: WorkflowAgentActivity[];
  toolCalls: number;
}

export type WorkflowJobState = "queued" | "running" | "paused" | "done" | "failed" | "cancelled";

export interface WorkflowJob {
  id: string;
  name: string;
  state: WorkflowJobState;
  script: string;
  startedAt: number;
  finishedAt?: number;
  /** What the script said about itself in `export const meta`. */
  description?: string;
  planned?: { title: string; agents: number }[];
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
  /** Agents still working, by id. Emptied as each one finishes. */
  live: Map<string, WorkflowLiveAgent>;
  journalPath?: string;
  /** Set when this job replays the journal of an earlier run. */
  resumedFrom?: string;
  /** Agents answered from that journal, and the tokens they had already spent. */
  replayed: number;
  replayedTokens: WorkflowUsage;
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
  /**
   * Resume this saved run: its script is replayed and every finished agent that
   * has not changed is answered from the journal instead of the model.
   */
  resumeFrom?: string;
}

export interface WorkflowJobManagerOptions {
  runAgent: WorkflowAgentRunner;
  config?: WorkflowConfig;
  /** Where journals live. A job with no agent dir runs without a journal. */
  agentDir?: string;
  now?: () => number;
  /** Called exactly once per job, when it settles. */
  onSettle?: (job: WorkflowJob) => void;
  /**
   * Ask before a tool runs. Handed straight to the runtime, which owns the
   * grants, so "allow for this run" cannot outlive the run.
   */
  approveTool?: (request: {
    facts: WorkflowToolFacts;
    asked: number;
    total?: number;
    /** The run that asked, so a card can name it. */
    workflow: string;
  }) => Promise<WorkflowToolDecision>;
  /**
   * Called whenever the number of live jobs changes. The waiting row above the
   * editor listens to this; it is one hook instead of one call per transition,
   * so a new transition cannot forget it.
   */
  onActiveChange?: (active: number) => void;
  /** For tests: run the job body on the current tick. */
  startImmediately?: boolean;
}

const RECENT_LIMIT = 60;

/**
 * A JSON-safe copy of a value, or undefined.
 *
 * Written by hand because a journal line must never fail: a value with a circular
 * reference, a function or a huge string simply does not get stored.
 */
export function safeJson(value: unknown, limit = 20_000): unknown {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    if (text === undefined || text.length > limit) return undefined;
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

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
    const resumeFrom = input.resumeFrom?.trim() || undefined;
    // A resume needs the original script, its name and its args, and the journal
    // it should read answers from. A missing run is a clear error, not a silence.
    const saved = resumeFrom ? this.loadRun(resumeFrom) : undefined;
    const script = saved?.script ?? input.script;
    const name = (saved?.name ?? (input.name && input.name.trim() !== "" ? input.name : "workflow")).slice(0, 60);
    const args = input.args ?? saved?.args;
    const replay = saved ? new WorkflowReplay(replayRecordsFromJournal(saved.entries)) : undefined;
    // The plan the script declared. Used by the panel to show a phase and its
    // queued agents before anything has finished; it never affects the run.
    const meta = parseWorkflowMeta(script);
    const planned = (meta.phases ?? []).map((phase) => ({
      title: phase.title,
      agents: phase.agents ?? 0,
    }));

    const job: WorkflowJob = {
      id,
      name,
      state: "queued",
      script,
      startedAt: this.now(),
      resumedFrom: resumeFrom,
      description: (meta.description ?? "").slice(0, 300) || undefined,
      planned: planned.length > 0 ? planned : undefined,
      running: 0,
      done: 0,
      failed: 0,
      tokens: emptyUsage(),
      replayed: 0,
      replayedTokens: emptyUsage(),
      phases: [],
      phaseStats: [],
      agents: [],
      recent: [],
      live: new Map(),
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
      script,
      maxAgents: this.config.maxAgents,
      wallClockMs: this.config.wallClockMs,
      args: safeJson(args),
      resumedFrom: resumeFrom,
    });

    const runtime = new WorkflowRuntime({
      runAgent: this.options.runAgent,
      config: this.config,
      now: this.now,
      args,
      slots: sharedSlotPool(),
      replay,
      // The script sees the run's start time: on a resume that is the ORIGINAL
      // start, so the script's own decisions and timestamps repeat exactly.
      scriptNow: saved?.startedAt ?? job.startedAt,
      // The job name travels with the ask, so a card can say which run is asking.
      approveTool: this.options.approveTool
        ? (request) => this.options.approveTool!({ ...request, workflow: job.name })
        : undefined,
      onEvent: (event) => {
        this.applyEvent(job, event, journal);
      },
    });
    this.runtimes.set(id, runtime);
    this.announceActive();

    const start = () => {
      job.state = "running";
      void runtime
        .run(script)
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
            replayed: result.replayed,
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
    // Newest first. Two runs can start in the same millisecond, so the id breaks
    // the tie: ids carry an increasing sequence, and a list whose order flips
    // between two identical timestamps is a list that flickers.
    return [...this.jobs.values()].sort((a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : -1));
  }

  /** Running, queued or paused jobs. */
  active(): WorkflowJob[] {
    return this.list().filter((job) => job.state !== "done" && job.state !== "failed" && job.state !== "cancelled");
  }

  cancel(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job) return false;
    if (job.state !== "running" && job.state !== "queued" && job.state !== "paused") return false;
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

  /**
   * Pause a running job: no new agent starts, the ones in flight finish, and the
   * wall clock stops. Nothing is lost and nothing is replayed on the way back.
   */
  pause(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state !== "running") return false;
    job.state = "paused";
    this.runtimes.get(id)?.pause();
    this.makeJournal(id)?.append({ kind: "log", at: this.now(), message: "paused by the user" });
    return true;
  }

  /** Carry on from exactly where a pause left off. No replay, no repeat cost. */
  resume(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job || job.state !== "paused") return false;
    job.state = "running";
    this.runtimes.get(id)?.resumeLive();
    this.makeJournal(id)?.append({ kind: "log", at: this.now(), message: "resumed by the user" });
    return true;
  }

  /**
   * Resume a run from its journal on disk: the script runs again from the top and
   * every finished, unchanged agent is answered from the record instead of the
   * model. This works after a pause, a cancel, a crash, or in a later session.
   */
  resumeFrom(runId: string): WorkflowJob {
    return this.launch({ script: "", resumeFrom: runId });
  }

  /** Runs on disk, newest first: what `/workflows saved` shows. */
  savedRuns(): SavedRun[] {
    const dir = this.options.agentDir ?? this.ensureAgentDir();
    if (!dir) return [];
    return listSavedRuns(journalDir(dir));
  }

  /** Read a saved run, or explain why it cannot be resumed. */
  private loadRun(runId: string): { script: string; name: string; args?: unknown; startedAt: number; entries: JournalEntry[] } {
    const journal = this.makeJournal(runId);
    const entries = journal?.read() ?? [];
    const start = entries[0];
    if (!start || start.kind !== "run_start") {
      throw new Error(`no saved workflow run ${runId} (nothing to resume)`);
    }
    return { script: start.script, name: start.name, args: start.args, startedAt: start.at, entries };
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

  /** Tell a listener how many runs are live, never letting it break a job. */
  private announceActive(): void {
    if (!this.options.onActiveChange) return;
    try {
      this.options.onActiveChange(this.active().length);
    } catch {
      // A display hook must never break the run it is reporting on.
    }
  }

  private settle(job: WorkflowJob): void {
    if (job.settledState) return;
    job.settledState = true;
    this.announceActive();
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
        job.live.set(event.id, {
          id: event.id,
          label: event.label,
          phase: event.phase,
          prompt: event.prompt,
          model: event.model,
          startedAt: event.at,
          activity: [],
          toolCalls: 0,
        });
        journal?.append({
          kind: "agent_start",
          at: event.at,
          id: event.id,
          label: event.label,
          phase: event.phase,
          prompt: event.prompt,
          model: event.model,
        });
        break;
      case "agent_activity": {
        const live = job.live.get(event.id);
        if (!live) break;
        live.toolCalls = Math.max(live.toolCalls + 1, event.count);
        live.activity.push({ tool: event.tool, detail: event.detail, turns: event.turns, at: event.at });
        if (live.activity.length > MAX_ACTIVITY_ROWS) {
          live.activity.splice(0, live.activity.length - MAX_ACTIVITY_ROWS);
        }
        // Activity is display-only: it changes nothing a replay would need, so it
        // stays out of the journal. A journal that grows with every tool call is a
        // journal that is slow to read and expensive to keep.
        break;
      }
      case "agent_end": {
        job.running = Math.max(0, job.running - 1);
        const live = job.live.get(event.id);
        job.live.delete(event.id);
        job.done += 1;
        if (!event.ok) job.failed += 1;
        // A replayed answer costs nothing now. It is counted apart, so the token
        // total always means "spent by this attempt".
        if (event.replayed) {
          job.replayed += 1;
          job.replayedTokens = addUsage(job.replayedTokens, event.usage);
        } else {
          job.tokens = addUsage(job.tokens, event.usage);
        }
        const record: WorkflowAgentRecord = {
          id: event.id,
          label: event.label,
          ok: event.ok,
          error: event.error,
          phase: event.phase,
          durationMs: event.durationMs,
          usage: event.usage,
          depth: event.depth,
          replayed: event.replayed,
          prompt: event.prompt ?? live?.prompt,
          activity: event.activity ?? live?.activity,
          toolCalls: event.toolCalls ?? live?.toolCalls,
          model: event.model ?? live?.model,
          data: event.data,
        };
        job.agents.push(record);
        const agentStats = job.phaseStats.find((stat) => stat.name === event.phase);
        if (agentStats && event.replayed) {
          agentStats.tokens = Math.max(0, agentStats.tokens - (event.usage?.total ?? 0));
        }
        journal?.appendAgentEnd({
          kind: "agent_end",
          at: event.at,
          id: event.id,
          ok: event.ok,
          error: event.error,
          usage: event.usage,
          durationMs: event.durationMs,
          text: (event as { text?: string }).text,
          key: event.id,
          scope: event.scope,
          index: event.index,
          fingerprint: event.fingerprint,
          replayed: event.replayed,
          prompt: record.prompt,
        });
        break;
      }
      case "paused":
        journal?.append({ kind: "log", at: event.at, message: "paused" });
        break;
      case "resumed":
        journal?.append({ kind: "log", at: event.at, message: "resumed" });
        break;
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
