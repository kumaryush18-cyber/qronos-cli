// The hidden instruction a keyword adds, and nothing else.
//
// The text must describe the runtime that actually exists. A notice that names
// helpers we did not build teaches the model to call air, so this file is kept
// next to the runtime and the tests check that every helper it mentions is real.
import { ORCHESTRATE_SECTION, ORCHESTRATE_WORD, ULTRACODE_SECTION, ULTRACODE_WORD, type Keyword } from "./ultrathink";

/** Helpers the sandbox really exposes. Tests compare the notice against this. */
export const WORKFLOW_HELPERS = ["agent", "parallel", "pipeline", "phase", "log", "workflow"] as const;

export const ULTRACODE_NOTICE = `The user wrote the word "ultracode" in this prompt. They want this task done as a
multi-agent workflow, the way Claude Code does it: you write a small script, the
script fans work out to subagents, and only the final result comes back to the
conversation.

Use the \`workflow\` tool once, with a script. Do not try to do the fan-out by
calling \`agent\` yourself in a loop: the script is what makes the results stay
out of this conversation.

Inside the script you have exactly five helpers:

- \`agent(prompt, { label?, schema?, model? })\` — one subagent. Resolves to
  \`{ ok, text, data, error, usage }\`. It never throws: check \`ok\` and skip the
  gap. Pass \`schema\` (JSON Schema) when you need data instead of prose; \`data\`
  is then validated for you. Pass \`model\` to route one stage to a cheaper model
  while the hard judgement stays on the strong one.
- \`parallel([...])\` — promises or functions, all started at once, order kept.
- \`pipeline(list, item => ...)\` — one task per item, concurrency-limited.
- \`phase("Understand")\` — a named step. Agents are counted and priced per
  phase, so name the phases you care about.
- \`log("...")\` — a note for the human.
- \`workflow("...script...")\` — a nested workflow, one level deep. It shares
  this run's agent budget, so nesting cannot double the cost.

Two read-only values: \`args\` (whatever the caller passed) and \`budget\`
(\`{ maxAgents, used(), remaining }\`). Use them to decide how much work to
start instead of guessing.

Rules of the runtime (do not fight them):
- Real JavaScript. No imports, no require, no process, no filesystem, no network.
- 10 minutes wall clock, 60 agents per run, 8 at a time. Name phases early, so
  the report can say which stage spent the tokens. Split very large jobs
  into several runs instead of one run over one thousand files.
- \`return\` one small value. Big results must be summarised in the script, not
  dumped; an oversized return is refused.

Phases worth naming: Understand, Review, Migrate, Research, Design. Use
\`parallel\` when items are independent; use a plain \`for\` loop with \`await\` when
each step needs the previous answer.

Report back in 3-6 lines: what ran, how many agents, what was found, and what
you did not cover. The point of the workflow is a small answer over large work.`;

export const ORCHESTRATE_NOTICE = `The user wrote the word "orchestrate" in this prompt. They want the work split
into independent parts and run in parallel instead of one long sequence.

For this turn:
- First list the independent parts (2-6 items). If the parts depend on each
  other, say so and keep them in order.
- For two or more independent items, call \`agent\` once per item in the same
  turn, with a \`label\` and, where you need data, an \`output_schema\`.
- For a job that needs many files and would flood this conversation, use the
  \`workflow\` tool instead, with a script.
- Then merge the reports yourself and state what you verified.`;

export function ultracodeSection(): string {
  return `## Ultracode workflow (this turn)\n${ULTRACODE_NOTICE}`;
}

export function orchestrateSection(): string {
  return `## Orchestrate (this turn)\n${ORCHESTRATE_NOTICE}`;
}

/** Which section a keyword adds. Used by the keyword extension. */
export const KEYWORD_SECTIONS: Partial<Record<Keyword, { section: string; build: () => string }>> = {
  [ULTRACODE_WORD]: { section: ULTRACODE_SECTION, build: ultracodeSection },
  [ORCHESTRATE_WORD]: { section: ORCHESTRATE_SECTION, build: orchestrateSection },
};
