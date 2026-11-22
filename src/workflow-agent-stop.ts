// Stopping one agent: the words, and the rules about when a stop is possible.
//
// A run has two sizes of stop. `stop the run` is one decision about the whole
// thing; `stop this agent` is a smaller decision about one call that is spending
// right now. They are different enough to keep apart: the small one must never
// look like a crash, and the big one must never leave an agent behind.

/** What a stopped agent says it is. One string, so nothing can drift. */
export const STOPPED_BY_USER = "stopped by you";

export type StopAgentOutcome = { ok: true; id: string } | { ok: false; error: string };

/** A stop that did not happen, with the reason a person can read. */
export function stopRefusal(error: string): StopAgentOutcome {
  return { ok: false, error };
}

/**
 * Why this agent cannot be stopped, or `undefined` when it can.
 *
 * The rules are the ones a person would guess:
 *
 *   - a run that has settled has nothing left to stop;
 *   - an agent that is not in the live map has not started yet, or has already
 *     finished, and either way there is no switch to press;
 *   - and a second press on an agent already being stopped says so rather than
 *     pretending it did something new.
 */
export function stopProblem(input: {
  state: string;
  live: boolean;
  alreadyStopping?: boolean;
}): string | undefined {
  if (input.state === "cancelled") return "that run was already stopped";
  if (input.state === "done" || input.state === "failed") return "that run has finished";
  if (input.alreadyStopping) return "that agent is already stopping";
  if (!input.live) return "that agent is not running any more";
  return undefined;
}

/**
 * How a stopped agent reads in a list.
 *
 * "stopped" is a decision, not a fault, so it never borrows the word "failed".
 * The reason is kept beside it, because "stopped" alone does not say by whom.
 */
export function stoppedNote(error?: string): string {
  return error && error !== STOPPED_BY_USER ? `stopped: ${error}` : "stopped by you";
}

/** What a word from the user pointed at, or why it did not. */
export type StopTarget = { id: string } | { error: string };

/**
 * Which live agent a word names.
 *
 * The rules are the ones the rest of the CLI uses: an id is exact, a label is
 * forgiving, and a word that matches several agents is refused with the list
 * rather than guessed. Stopping the wrong agent is spending money on the wrong
 * work, so a guess here is the most expensive guess in the tool.
 */
export function resolveStopTarget(live: Iterable<{ id: string; label: string }>, word: string): StopTarget {
  const wanted = word.trim().toLowerCase();
  if (wanted === "") return { error: "name an agent: /workflows stop <id> <agent>" };
  const agents = [...live];
  if (agents.length === 0) return { error: "no agent is running in that workflow" };
  const byId = agents.find((agent) => agent.id.toLowerCase() === wanted);
  if (byId) return { id: byId.id };
  // The panel prints ids as `#1`, so a bare `1` is the same word with the hash
  // left off. Accepting it costs nothing and saves a confusing refusal.
  const bare = agents.find((agent) => agent.id.toLowerCase() === `#${wanted}`);
  if (bare) return { id: bare.id };
  const exact = agents.find((agent) => agent.label.toLowerCase() === wanted);
  if (exact) return { id: exact.id };
  const partial = agents.filter((agent) => agent.label.toLowerCase().includes(wanted));
  if (partial.length === 1) return { id: partial[0]!.id };
  if (partial.length > 1) {
    const names = partial.map((agent) => `${agent.id} ${agent.label}`).join(", ");
    return { error: `"${word}" matches more than one agent: ${names}` };
  }
  const running = agents.map((agent) => `${agent.id} ${agent.label}`).join(", ");
  return { error: `no running agent matches "${word}": ${running}` };
}
