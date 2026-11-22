// Run one agent again, without touching the rest of the run.
//
// Claude Code lets you re-run a single agent from the detail view. It is useful
// and it is not free: a restart is a fresh model call, so the row must show that
// the tokens went up and the answer is new, not replayed.
//
// Three rules:
//
//   1. It costs money, so the caller asks first.
//   2. It never lies about the ledger: `tokens` rises, `replayedTokens` does not.
//   3. It never touches another agent. Only the chosen record changes.
import type { WorkflowAgentRecord, WorkflowAgentRequest, WorkflowAgentResult, WorkflowAgentRunner } from "./workflow-types";
import { addUsage } from "./workflow-types";
import type { WorkflowJob } from "./workflow-jobs";
import type { WorkflowJournal } from "./workflow-journal";

/** Why a restart was not started. The caller shows this, never a silent nothing. */
export interface RestartRefusal {
  ok: false;
  error: string;
}

export interface RestartDone {
  ok: true;
  agent: WorkflowAgentRecord;
}

export type RestartOutcome = RestartDone | RestartRefusal;

/**
 * The request for a restart: the same words, model and phase the agent had.
 *
 * The prompt is the one kept with the record, which is redacted and capped. That
 * is the honest limit of a restart after the run has finished: the exact original
 * text is gone with the run, and pretending otherwise would send a different task
 * under the same name.
 */
export function restartRequest(record: WorkflowAgentRecord): WorkflowAgentRequest {
  return {
    prompt: record.prompt ?? `(the task for "${record.label}" was not kept; repeat the same work)`,
    label: record.label,
    model: record.model,
    phase: record.phase,
  };
}

/** Why this agent cannot be restarted right now, or undefined when it can. */
export function restartRefusal(job: WorkflowJob | undefined, agentId: string): string | undefined {
  if (!job) return "no such run";
  if (job.state === "running" || job.state === "queued" || job.state === "paused") {
    return "this run is still going; stop it first, so two agents cannot spend at once";
  }
  const record = job.agents.find((agent) => agent.id === agentId);
  if (!record) return "no such agent in this run";
  return undefined;
}

/**
 * Run the agent again and fold the answer into the record.
 *
 * The caller owns the job, so this function owns only the one call. Keeping the
 * write small is what makes "the other agents are untouched" true by
 * construction rather than by care.
 */
export async function restartAgent(input: {
  job: WorkflowJob;
  agentId: string;
  runAgent: WorkflowAgentRunner;
  signal?: AbortSignal;
  now?: () => number;
  journal?: WorkflowJournal;
}): Promise<RestartOutcome> {
  const { job, agentId, runAgent } = input;
  const now = input.now ?? Date.now;
  const refusal = restartRefusal(job, agentId);
  if (refusal) return { ok: false, error: refusal };

  const record = job.agents.find((agent) => agent.id === agentId)!;
  const startedAt = now();
  const result: WorkflowAgentResult = await runAgent(restartRequest(record), input.signal ?? new AbortController().signal);
  const durationMs = Math.max(0, now() - startedAt);

  // A restart is new work: the answer replaces the old one, and the tokens are
  // spent again. `replayed` goes back to false for the same reason.
  record.ok = result.ok;
  record.error = result.error;
  record.durationMs = durationMs;
  record.usage = result.usage;
  record.replayed = false;
  record.restarted = true;
  record.restartedAt = startedAt;
  record.contextWindow = result.contextWindow ?? record.contextWindow;
  // The old tool rows belong to the old attempt; a restart starts with none.
  record.activity = undefined;
  record.toolCalls = undefined;
  if (result.data !== undefined) record.data = result.data;

  job.tokens = addUsage(job.tokens, result.usage);
  const stat = job.phaseStats.find((entry) => entry.name === record.phase);
  if (stat) {
    stat.tokens += result.usage?.total ?? 0;
    stat.agents += 0;
  }

  input.journal?.append({
    kind: "log",
    at: startedAt,
    message: `agent "${record.label}" restarted (${result.ok ? "ok" : "failed"})`,
  });
  return { ok: true, agent: record };
}
