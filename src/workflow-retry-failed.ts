// Run the failed agents again, and only those.
//
// After a big run there are usually two or three agents with a red cross and a
// dozen good answers. Rerunning everything spends money on work that is already
// right; rerunning nothing leaves holes in the report. This is the small,
// obvious third thing.
//
// Three rules, borrowed from the restart and the phase rerun because they are the
// same three:
//
//   1. It costs money, so the caller asks first, and the card says how many.
//   2. New work, not a replay: the tokens rise and the rows say they ran again.
//   3. One at a time, so the bill stays readable.
//
// And one rule of its own: **a stopped agent is not a failed one.** You stopped
// it on purpose; a key that quietly starts it again would undo your decision.
import type { WorkflowAgentRecord } from "./workflow-types";
import type { WorkflowJob } from "./workflow-jobs";
import type { PhaseRerunSkipped } from "./workflow-phase-rerun";
import type { RestartOutcome } from "./workflow-restart";

export interface RetryRefusal {
  ok: false;
  error: string;
}

export interface RetryDone {
  ok: true;
  /** How many agents really ran again. */
  ran: number;
  /** How many had failed when the retry started. */
  total: number;
  skipped: PhaseRerunSkipped[];
}

export type RetryOutcome = RetryDone | RetryRefusal;

/**
 * The agents worth running again: failed, and not stopped by you.
 *
 * A replayed agent that failed is included: the journal gave back an answer that
 * did not pass its schema, which is exactly the thing to try again.
 */
export function failedAgents(job: WorkflowJob): WorkflowAgentRecord[] {
  return job.agents.filter((agent) => !agent.ok && agent.stopped !== true);
}

/** Why nothing can be retried right now, or `undefined` when something can. */
export function retryRefusal(job: WorkflowJob | undefined): string | undefined {
  if (!job) return "no such run";
  if (job.state === "running" || job.state === "paused" || job.state === "queued") {
    return "stop the run first: two agents must not spend at once";
  }
  const stopped = job.agents.filter((agent) => !agent.ok && agent.stopped === true).length;
  if (failedAgents(job).length === 0) {
    if (stopped > 0) {
      return stopped === 1
        ? "nothing failed in this run: the one that is marked stopped was stopped by you"
        : `nothing failed in this run: the ${stopped} that are marked stopped were stopped by you`;
    }
    return "nothing failed in this run";
  }
  return undefined;
}

/** The facts on the confirm card, at most four. */
export function retryFailedLines(job: WorkflowJob): string[] {
  const agents = failedAgents(job);
  const spent = agents.reduce((total, agent) => total + (agent.usage?.total ?? 0), 0);
  const first = agents
    .slice(0, 2)
    .map((agent) => agent.label)
    .join(", ");
  const more = agents.length > 2 ? ` +${agents.length - 2}` : "";
  return [
    `${agents.length} failed agent${agents.length === 1 ? "" : "s"} run again, one at a time`,
    first === "" ? "" : `${first}${more}`,
    `they spent ${spent.toLocaleString("en-US")} tokens the first time`,
    "this is new work: the bill goes up",
  ].filter((line) => line !== "");
}

/** The title the card and the notice share. */
export function retryFailedTitle(job: WorkflowJob): string {
  const count = failedAgents(job).length;
  return count === 1 ? "Run the failed agent again?" : `Run the ${count} failed agents again?`;
}

/**
 * Run every failed agent again, one after another.
 *
 * A retry that fails again is not a reason to stop the others, and it is not
 * counted twice: the record keeps its new attempt, so the report shows the work
 * that was really done.
 */
export async function retryFailed(
  job: WorkflowJob,
  restart: (agentId: string) => Promise<RestartOutcome>,
): Promise<RetryOutcome> {
  const problem = retryRefusal(job);
  if (problem) return { ok: false, error: problem };
  const agents = failedAgents(job);
  const skipped: PhaseRerunSkipped[] = [];
  let ran = 0;
  for (const agent of agents) {
    const outcome = await restart(agent.id);
    if (outcome.ok) ran += 1;
    else skipped.push({ label: agent.label, error: outcome.error });
  }
  return { ok: true, ran, total: agents.length, skipped };
}

/** One line for a notice. */
export function retryFailedNotice(outcome: RetryOutcome): string {
  if (!outcome.ok) return outcome.error;
  const base = `ran ${outcome.ran} of ${outcome.total} failed again: the tokens went up`;
  if (outcome.skipped.length === 0) return base;
  const first = outcome.skipped[0]!;
  const more = outcome.skipped.length > 1 ? ` (+${outcome.skipped.length - 1} more)` : "";
  return `${base} · ${first.label} did not run: ${first.error}${more}`;
}
