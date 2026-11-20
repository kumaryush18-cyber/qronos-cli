// Agent Hub, part A: the registry.
//
// Today a subagent runs out of sight: the model calls `agent`, something happens
// for a while, and a report comes back. There is no answer to "how many are
// running, what are they doing, and why is one stuck?".
//
// This module is the state behind that answer. It is a plain state machine with
// no TUI, no timers and no I/O, so the awkward cases (a subagent that fails, one
// killed mid-run, a fan-out of six) are unit tested instead of discovered.
//
// Part B adds typed results to the `agent` tool, and part C draws this registry
// as a live roster (Alt+A). Keeping the state separate means C can be a pure
// renderer over `list()`.

export type AgentStatus = "queued" | "running" | "waiting-approval" | "done" | "failed" | "killed";

export interface AgentStartInput {
  /** Short label from the tool call, e.g. "map auth flow". */
  description: string;
  /** Full task text handed to the subagent. */
  prompt: string;
  /** Subagent type: general-purpose, Explore, Plan, or a custom name. */
  type: string;
  /** Model id the subagent runs on, when known. */
  model?: string;
  /** 1 = spawned by the main session. */
  depth?: number;
  /** Turn budget, for "3/10" in the roster. */
  maxTurns?: number;
  /** Injectable clock, so tests are not timing-dependent. */
  now?: number;
}

export interface AgentRecord {
  /** Stable id for this session, e.g. "agent-1". */
  id: string;
  /** 1-based spawn order, used for display. */
  index: number;
  description: string;
  prompt: string;
  type: string;
  status: AgentStatus;
  startedAt: number;
  endedAt?: number;
  turns: number;
  maxTurns: number;
  depth: number;
  model?: string;
  lastTool?: string;
  toolsUsed: string[];
  /** Size of the final report, for a token-cost hint. */
  outputChars?: number;
  /** Set when status is failed or killed. */
  error?: string;
  /** Messages the user sent to this agent while it was running. */
  steering?: string[];
}

export interface AgentFinishInput {
  status: Extract<AgentStatus, "done" | "failed" | "killed">;
  turns?: number;
  toolsUsed?: string[];
  outputChars?: number;
  error?: string;
  now?: number;
}

export type RegistryListener = (records: readonly AgentRecord[]) => void;

export class AgentRegistry {
  private readonly records = new Map<string, AgentRecord>();
  private readonly listeners = new Set<RegistryListener>();
  /** How to stop one agent, registered by whoever started it. */
  private readonly aborts = new Map<string, () => void>();
  /** How to run an agent again, registered by whoever started it. */
  private readonly revivers = new Map<string, () => void>();
  private nextIndex = 1;

  start(input: AgentStartInput): AgentRecord {
    const index = this.nextIndex++;
    const record: AgentRecord = {
      id: `agent-${index}`,
      index,
      description: input.description,
      prompt: input.prompt,
      type: input.type,
      status: "running",
      startedAt: input.now ?? Date.now(),
      turns: 0,
      maxTurns: input.maxTurns ?? 10,
      depth: input.depth ?? 1,
      model: input.model,
      toolsUsed: [],
      steering: [],
    };
    this.records.set(record.id, record);
    this.emit();
    return record;
  }

  /** Mark one turn finished and remember the tool it just used. */
  progress(id: string, update: { turns?: number; tool?: string } = {}): AgentRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    if (update.turns !== undefined) record.turns = update.turns;
    if (update.tool && !record.toolsUsed.includes(update.tool)) record.toolsUsed.push(update.tool);
    if (update.tool) record.lastTool = update.tool;
    this.emit();
    return record;
  }

  waitForApproval(id: string): AgentRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    record.status = "waiting-approval";
    this.emit();
    return record;
  }

  finish(id: string, input: AgentFinishInput): AgentRecord | undefined {
    const record = this.records.get(id);
    if (!record) return undefined;
    // A finished agent must not go back to running if a late turn event arrives.
    if (record.status === "done" || record.status === "failed" || record.status === "killed") return record;
    record.status = input.status;
    record.endedAt = input.now ?? Date.now();
    if (input.turns !== undefined) record.turns = input.turns;
    if (input.toolsUsed?.length) {
      for (const tool of input.toolsUsed) if (!record.toolsUsed.includes(tool)) record.toolsUsed.push(tool);
    }
    if (input.outputChars !== undefined) record.outputChars = input.outputChars;
    if (input.error) record.error = input.error;
    this.emit();
    return record;
  }

  /** Register how to stop this agent, so the Hub's `k` can work. */
  setAbort(id: string, abort: () => void): void {
    this.aborts.set(id, abort);
  }

  /** Register how to run this agent again, so the Hub's `r` can work. */
  setReviver(id: string, revive: () => void): void {
    this.revivers.set(id, revive);
  }

  /** Stop one agent. Returns false when it was already finished. */
  abort(id: string, reason = "stopped by you", now = Date.now()): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "waiting-approval" && record.status !== "queued") {
      return false;
    }
    try {
      this.aborts.get(id)?.();
    } catch {
      // A broken abort handler must still leave the record consistent.
    }
    this.aborts.delete(id);
    record.status = "killed";
    record.endedAt = now;
    record.error = reason;
    this.emit();
    return true;
  }

  /** Run an agent again with the same task. Returns false when it cannot. */
  revive(id: string): boolean {
    const revive = this.revivers.get(id);
    if (!revive) return false;
    try {
      revive();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Send a message to a running agent. It is delivered at the next turn
   * boundary, because a model request already in flight cannot be edited.
   */
  steer(id: string, text: string): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "waiting-approval") return false;
    const message = text.trim();
    if (message === "") return false;
    record.steering = [...(record.steering ?? []), message];
    this.emit();
    return true;
  }

  /** Take the queued steering messages, so each one is delivered once. */
  takeSteering(id: string): string[] {
    const record = this.records.get(id);
    if (!record?.steering?.length) return [];
    const messages = record.steering;
    record.steering = [];
    return messages;
  }

  /** Kill any agent that is still running; used on session shutdown. */
  killAll(reason = "session ended", now = Date.now()): AgentRecord[] {
    const killed: AgentRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status === "running" || record.status === "queued" || record.status === "waiting-approval") {
        record.status = "killed";
        record.endedAt = now;
        record.error = reason;
        killed.push(record);
      }
    }
    if (killed.length > 0) this.emit();
    return killed;
  }

  get(id: string): AgentRecord | undefined {
    return this.records.get(id);
  }

  list(): AgentRecord[] {
    return [...this.records.values()].sort((a, b) => a.index - b.index);
  }

  running(): AgentRecord[] {
    return this.list().filter((record) => record.status === "running" || record.status === "waiting-approval");
  }

  clear(): void {
    this.records.clear();
    this.aborts.clear();
    this.revivers.clear();
    this.nextIndex = 1;
    this.emit();
  }

  subscribe(listener: RegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.list();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A bad listener (a broken widget) must never stop a subagent.
      }
    }
  }
}

/** One-line status for the footer, e.g. "2 agents · Explore 3/10 · Plan done". */
export function formatAgentSummary(records: readonly AgentRecord[], now = Date.now()): string {
  if (records.length === 0) return "";
  const active = records.filter((record) => record.status === "running" || record.status === "waiting-approval");
  if (active.length === 0) {
    const done = records.filter((record) => record.status === "done").length;
    const failed = records.length - done;
    return failed === 0 ? `${done} agent${done === 1 ? "" : "s"} done` : `${done} done · ${failed} failed`;
  }
  const parts = active.slice(0, 3).map((record) => {
    const state = record.status === "waiting-approval" ? "needs approval" : `${record.turns}/${record.maxTurns}`;
    return `${shortType(record.type)} ${state}`;
  });
  const more = active.length > 3 ? ` +${active.length - 3}` : "";
  return `${active.length} agent${active.length === 1 ? "" : "s"} · ${parts.join(" · ")}${more}`;
}

/** Roster lines for the Hub overlay (part C renders this, tests check it here). */
export function formatAgentRoster(records: readonly AgentRecord[], now = Date.now()): string[] {
  if (records.length === 0) return ["No subagents in this session."];
  return records.map((record) => {
    const icon = statusIcon(record.status);
    const elapsed = formatElapsed((record.endedAt ?? now) - record.startedAt);
    const turns = `${record.turns}/${record.maxTurns}`;
    const tool = record.lastTool ? ` · ${record.lastTool}` : "";
    const error = record.error ? ` · ${truncate(record.error, 40)}` : "";
    return `${icon} ${record.index}. ${truncate(record.description, 34)}  ${shortType(record.type)} · ${turns} · ${elapsed}${tool}${error}`;
  });
}

export function statusIcon(status: AgentStatus): string {
  switch (status) {
    case "running":
      return "✻";
    case "waiting-approval":
      return "?";
    case "done":
      return "✓";
    case "failed":
      return "✗";
    case "killed":
      return "⊘";
    default:
      return "·";
  }
}

export function shortType(type: string): string {
  const value = (type || "general-purpose").toLowerCase();
  if (value.startsWith("explore")) return "Explore";
  if (value.startsWith("plan")) return "Plan";
  if (value.startsWith("general")) return "General";
  return type;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function truncate(text: string, limit: number): string {
  const single = text.replace(/\s+/g, " ").trim();
  return single.length <= limit ? single : `${single.slice(0, limit - 1)}…`;
}
