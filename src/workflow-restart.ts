// Run one agent again, without touching the rest of the run.
//
// Claude Code lets you re-run a single agent from the detail view, and lets you
// change the task first, because usually the words were unclear rather than the
// model being wrong. It is useful and it is not free: a restart is a fresh model
// call, so the row must show that the tokens went up and that the answer is new.
//
// Three rules:
//
//   1. It costs money, so the caller asks first.
//   2. It never lies about the ledger: `tokens` rises, `replayedTokens` does not.
//   3. It never touches another agent. Only the chosen record changes.
import type {
  WorkflowAgentAttempt,
  WorkflowAgentRecord,
  WorkflowAgentRequest,
  WorkflowAgentResult,
  WorkflowAgentRunner,
} from "./workflow-types";
import { addUsage } from "./workflow-types";
import { applySchema } from "./workflow-schema";
import type { WorkflowJob } from "./workflow-jobs";
import type { WorkflowJournal } from "./workflow-journal";

/** How many attempts a record keeps. Enough to see the story, not a full log. */
export const MAX_ATTEMPTS = 5;

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
 * The request for a restart: the same words, model and phase the agent had —
 * unless the user changed the words, in which case their text wins.
 *
 * The prompt kept with the record is redacted and capped. That is the honest
 * limit of a restart after the run has finished: the exact original text is gone
 * with the run, and pretending otherwise would send a different task under the
 * same name.
 */
export function restartRequest(record: WorkflowAgentRecord, prompt?: string): WorkflowAgentRequest {
  const edited = typeof prompt === "string" && prompt.trim() !== "" ? prompt : undefined;
  return {
    prompt: edited ?? record.prompt ?? `(the task for "${record.label}" was not kept; repeat the same work)`,
    label: record.label,
    model: record.model,
    phase: record.phase,
    // The same test as the first time. An edited task is still expected to answer
    // the question it was given a schema for.
    schema: record.schema as WorkflowAgentRequest["schema"],
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
  /** New words for this attempt. Absent means "the same task again". */
  prompt?: string;
  signal?: AbortSignal;
  now?: () => number;
  journal?: WorkflowJournal;
}): Promise<RestartOutcome> {
  const { job, agentId, runAgent } = input;
  const now = input.now ?? Date.now;
  const refusal = restartRefusal(job, agentId);
  if (refusal) return { ok: false, error: refusal };

  const record = job.agents.find((agent) => agent.id === agentId)!;
  const request = restartRequest(record, input.prompt);
  const edited = typeof input.prompt === "string" && input.prompt.trim() !== "" ? input.prompt.trim() : undefined;

  const startedAt = now();
  // The same test as the first time. Without this a restart of an agent that
  // failed its schema would "succeed" with unchecked words.
  const result: WorkflowAgentResult = applySchema(
    await runAgent(request, input.signal ?? new AbortController().signal),
    request.schema,
  );
  const durationMs = Math.max(0, now() - startedAt);

  // The history is written before the record changes, so it always holds what was
  // really asked. It is capped: a record that grows for ever is a record nobody
  // reads.
  const attempts: WorkflowAgentAttempt[] = [...(record.attempts ?? [])];
  attempts.push({
    at: startedAt,
    ok: result.ok,
    error: result.error,
    tokens: result.usage?.total,
    durationMs,
    prompt: edited,
  });
  record.attempts = attempts.slice(-MAX_ATTEMPTS);

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
  // The task that was really sent, so the Prompt block never shows words that
  // were not used.
  if (edited) record.prompt = edited;
  // The old tool rows belong to the old attempt; a restart starts with none.
  record.activity = undefined;
  record.toolCalls = undefined;
  if (result.data !== undefined) record.data = result.data;

  job.tokens = addUsage(job.tokens, result.usage);
  const stat = job.phaseStats.find((entry) => entry.name === record.phase);
  if (stat) {
    stat.tokens += result.usage?.total ?? 0;
  }

  input.journal?.append({
    kind: "log",
    at: startedAt,
    message: `agent "${record.label}" restarted${edited ? " with an edited task" : ""} (${result.ok ? "ok" : "failed"})`,
  });
  return { ok: true, agent: record };
}
