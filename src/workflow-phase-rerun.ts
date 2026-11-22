// Run a whole phase again, without touching the rest of the run.
//
// One agent at a time is a restart. A whole phase is the same idea at a bigger
// size: yesterday's code was edited, the phase read the old file, so every agent
// in it is out of date. Doing that by hand is `r`, wait, `↑`, `r`, wait — which
// nobody does correctly.
//
// Three rules, the same three as a single restart:
//
//   1. It costs money, so the caller asks first, and the card says how many.
//   2. It is new work, not a replay: the tokens rise and the rows say they ran
//      again. A report must never pass old work off as new.
//   3. It never runs two at once. Sequential calls keep the bill readable and
//      keep the one-restart-at-a-time guard true.
import type { WorkflowAgentRecord } from "./workflow-types";
import type { WorkflowJob } from "./workflow-jobs";
import type { RestartOutcome } from "./workflow-restart";

/** An agent that did not run again, and the reason a person can read. */
export interface PhaseRerunSkipped {
  label: string;
  error: string;
}

export interface PhaseRerunRefusal {
  ok: false;
  error: string;
}

export interface PhaseRerunDone {
  ok: true;
  phase: string;
  /** How many agents really ran again. */
  ran: number;
  /** How many the phase had when the rerun started. */
  total: number;
  /** The ones that did not run, and why. Empty is the happy case. */
  skipped: PhaseRerunSkipped[];
}

export type PhaseRerunOutcome = PhaseRerunDone | PhaseRerunRefusal;

/** Every agent of one phase, in the order the run produced them. */
export function agentsOfPhase(job: WorkflowJob, phase: string): WorkflowAgentRecord[] {
  return job.agents.filter((agent) => (agent.phase ?? "") === phase);
}

/**
 * Why this phase cannot be run again, or `undefined` when it can.
 *
 * The phase name is forgiving about nothing: a run has a short list of phase
 * names and a wrong one is answered with that list, because guessing which phase
 * someone meant spends money on work they did not ask for.
 */
export function phaseRerunRefusal(job: WorkflowJob | undefined, phase: string): string | undefined {
  if (!job) return "no such run";
  if (job.state === "running" || job.state === "paused" || job.state === "queued") {
    return "stop the run first: two agents must not spend at once";
  }
  const wanted = phase.trim();
  if (wanted === "") {
    const names = job.phases.filter((name) => name !== "").join(", ");
    return names === "" ? "this run has no named phases" : `name a phase: ${names}`;
  }
  if (!job.phases.includes(wanted)) {
    const names = job.phases.filter((name) => name !== "").join(", ");
    return names === "" ? `no phase called "${wanted}": this run has no named phases` : `no phase called "${wanted}": ${names}`;
  }
  if (agentsOfPhase(job, wanted).length === 0) return `the phase "${wanted}" has no agents to run again`;
  return undefined;
}

/**
 * The facts on the confirm card, at most four.
 *
 * They answer the three questions a person asks before spending money again:
 * what, how many, and what it costs. The old cost is the honest number for "this
 * is what you are buying a second time".
 */
export function phaseRerunLines(job: WorkflowJob, phase: string): string[] {
  const agents = agentsOfPhase(job, phase);
  const spent = agents.reduce((total, agent) => total + (agent.usage?.total ?? 0), 0);
  const lines = [
    `phase: ${phase}`,
    `${agents.length} agent${agents.length === 1 ? "" : "s"} run again, one at a time`,
    `they spent ${spent.toLocaleString("en-US")} tokens the first time`,
    "this is new work: the bill goes up",
  ];
  return lines.slice(0, 4);
}

/** The title the card and the notice share, so they cannot drift apart. */
export function phaseRerunTitle(phase: string): string {
  return `Run the phase "${phase}" again?`;
}

/**
 * Run every agent of a phase again, one after another.
 *
 * A failure in the middle does not stop the rest: the phase is a set of separate
 * questions, and one agent that cannot run is not a reason to leave the other
 * four out of date. What did not run is counted and reported, never swallowed.
 */
export async function rerunPhase(
  job: WorkflowJob,
  phase: string,
  restart: (agentId: string) => Promise<RestartOutcome>,
): Promise<PhaseRerunOutcome> {
  const problem = phaseRerunRefusal(job, phase);
  if (problem) return { ok: false, error: problem };
  const agents = agentsOfPhase(job, phase);
  const skipped: PhaseRerunSkipped[] = [];
  let ran = 0;
  for (const agent of agents) {
    const outcome = await restart(agent.id);
    if (outcome.ok) ran += 1;
    else skipped.push({ label: agent.label, error: outcome.error });
  }
  return { ok: true, phase, ran, total: agents.length, skipped };
}

/** One line for a notice: what happened, in the smallest words. */
export function phaseRerunNotice(outcome: PhaseRerunOutcome): string {
  if (!outcome.ok) return outcome.error;
  const base = `ran ${outcome.ran} of ${outcome.total} again in "${outcome.phase}": the tokens went up`;
  if (outcome.skipped.length === 0) return base;
  const first = outcome.skipped[0]!;
  const more = outcome.skipped.length > 1 ? ` (+${outcome.skipped.length - 1} more)` : "";
  return `${base} · ${first.label} did not run: ${first.error}${more}`;
}
