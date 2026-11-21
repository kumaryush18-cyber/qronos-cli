# Workflows — the `ultracode` keyword

Write the word **`ultracode`** in a prompt, and Qronos CLI does the job the way
Claude Code does it: the model writes a small JavaScript script, the script
splits the work across subagents, and **only the final value comes back to the
chat**. Your conversation does not fill up with one hundred file dumps.

```
ultracode audit every route in src/routes for a missing auth check
```

The word is painted orange in the input box while you type it, the same way
`ultrathink` is.

## It runs in the background

Like Claude Code, the launch is **non-blocking**: the tool returns at once with a
job id (`wf_qhj6qy01`), the workflow keeps running while you talk, and the report
arrives as a message on a later turn.

```
ultracode audit every route in src/routes for a missing auth check
→ ✻ workflow audit launched as wf_qhj6qy01
```

- `/workflows` — the live list: state, agents running, done, tokens, time.
- `/workflows wf_qhj6qy01` — one job in detail, phase by phase.
- `/workflows stop wf_qhj6qy01` — stops scheduling and aborts what is in flight.

If the caller needs the value **inside the same turn**, it can pass
`background: false`; the tool then waits and returns the report directly. That is
what the tests and `scripts/workflow-e2e.ts` use.

Background jobs and chat subagents draw from **one** slot pool, so a background
workflow can never double the concurrency limit behind your back.

## The journal

Every run writes `~/.qronos/agent/workflow-runs/<job id>.jsonl` while it happens:
the script, each phase, each agent start and end with its tokens and its time, and
the final result. One line per event, append-only.

Reasons, in order of importance:

1. **Resume.** A JavaScript function cannot be frozen half way, so a resumed run
   replays the script and gets the recorded answers back instead of calling the
   model again.
2. **Trust.** After a crash you can read what ran, in order, without guessing.
3. **Bugs.** A report that looks wrong can be checked against the record.

A crash can only damage the last line, and the reader skips a line it cannot
parse. Agent answers are **redacted before they are written**, because a journal
outlives the session that made it. Answers are capped at 4 000 characters.

Old journals are pruned: the newest 20 runs are always kept, anything older than
7 days is removed, and the folder never grows past 200 files.

## Why a script, and not just many `agent` calls

A tool call returns its result into the conversation. Ten calls return ten
results. A script keeps intermediate results in **variables**, so only one value
survives. That single difference is what makes a big job affordable.

## What the script may use

Exactly five helpers. Nothing else exists inside the sandbox.

| Helper | What it does |
|---|---|
| `agent(prompt, { label?, schema?, model? })` | Runs one subagent. Resolves to `{ ok, text, data, error, usage }`. It never throws. |
| `parallel([...])` | Runs promises or functions at once. Order is kept. |
| `pipeline(list, item => ...)` | One task per item, limited to the allowed concurrency. |
| `phase("Review")` | Names a step. Agents and tokens are counted per phase. |
| `log("...")` | A note for the human. |
| `workflow("...")` | A nested workflow. One child level, sharing this run's budget. |

Two read-only values are also there: `args` (what the caller passed) and
`budget` (`{ maxAgents, used(), remaining }`).

Optional: `export const meta = { name, description }` at the top, and a
`return` with the value you want back.

```js
export const meta = { name: "audit-routes", description: "find routes without auth" }

phase("Understand")
const list = await agent("List every .ts file under src/routes/", {
  schema: { type: "object", required: ["files"],
            properties: { files: { type: "array", items: { type: "string" } } } },
})

phase("Review")
const found = await pipeline(list.data.files, (file) =>
  agent(`Does ${file} check the session before doing work? Return one short paragraph.`, { label: file }))

return found.filter((r) => r.ok).map((r) => r.text)
```

## The limits, and why they are there

| Limit | Default | Env var |
|---|---|---|
| Wall clock for the whole run | **10 minutes** | `QRONOS_WORKFLOW_WALL_CLOCK_MS` |
| Agents per run | 60 | `QRONOS_WORKFLOW_MAX_AGENTS` |
| Agents at the same time | 8 | `QRONOS_WORKFLOW_CONCURRENCY` |
| Log lines kept | 500 | `QRONOS_WORKFLOW_MAX_LOGS` |
| Result size | 200 000 chars | `QRONOS_WORKFLOW_MAX_RESULT_CHARS` |
| Journal keep | 7 days, newest 20 | `JOURNAL_KEEP_DAYS` / `JOURNAL_KEEP_RUNS` |

Ten minutes is deliberate. A two-minute cap turns a real audit into a failed one.
The agent cap is there because one workflow can spend a lot of tokens: 60 is
already a big job, and a script that needs more should be split into several runs.

Nothing is dropped silently: when the log cap is reached, the report says so, and
a run that hits the agent cap fails with a message that names the env var.

## Safety — what is really true

The script runs in a Node `vm` context that has:

- no `process`, `require`, `Bun`, `fetch`, `fs` or network;
- `codeGeneration: { strings: false }`, so `eval` and the `Function` constructor
  are refused **inside** that context (the classic
  `({}).constructor.constructor("return process")()` escape fails here);
- only the five helpers passed in, as the sole way out.

Also refused before anything runs: `import`, `require`, and any mention of
`process`, `Bun`, `node:fs` or `node:child_process`.

Be honest about the edge: a `vm` context is a strong guard against mistakes and
casual scripts, not a formal boundary against a determined attacker who writes
deliberately malicious code. The script comes from your own model, in your own
session, and it has no reason to attack you. That is the trade we chose.

## Routing a stage to a cheaper model

`agent(prompt, { model: "claude-haiku-5.5" })` runs that one agent on another
model. Mechanical extraction on a fast model, the hard judgement on the strong
one, is the pattern Claude Code recommends.

## Tokens

Every agent reports what it burned. The run adds them up, and `/workflows` shows
the split (in / out) plus a bar per agent and per phase, so "who did how much
work" is visible without reading numbers. This comes from the provider's own
usage report; an agent that reports nothing counts as zero, never as NaN.

## Seeing what happened

- A live line while it runs: `✻ Review · 3 running · 9 done · 42.1k tokens`.
- Every run ends with a table in the chat: agents, time, tokens, one row per
  phase with a bar, then the value and a short log tail.
- `/workflows` shows the last run in detail: each agent sorted by cost, with a
  bright green ✓ or a dark red ✗, its tokens, its time, and its error.
- `phase(...)` names appear in both places, so the report reads like a plan.

## When a subagent fails

The run does not die. The failed task becomes `{ ok: false, error }`, the other
tasks finish, and the report counts the failures. A gap is visible, never silent.

## `orchestrate` — the small cousin

`orchestrate` does not use a script. It adds a hidden instruction for that turn:
list the independent parts, run them as parallel `agent` calls with typed
results, then merge and report. Use it for 2–6 items; use `ultracode` when the
work is big enough to flood the chat.

## Turning it off

`QRONOS_ULTRATHINK=0` turns the keywords off, and with them the ultracode and
orchestrate notices. The `workflow` tool stays registered but nobody is told to
use it, so it can only be called when the model asks for it directly.

## Files

| File | Job |
|---|---|
| `src/workflow-types.ts` | Config, events, result types, errors. |
| `src/workflow-sandbox.ts` | The `vm` context, `meta` parsing, script checks. |
| `src/workflow-runtime.ts` | Semaphore, caps, schema check, event log, `run()`. |
| `src/workflow-tool.ts` | The `workflow` tool, the report, `/workflows`. |
| `src/workflow-notice.ts` | The hidden instructions for `ultracode` / `orchestrate`. |
| `src/workflow-glyphs.ts` | Ticks, crosses, bars, durations: the visuals, pure. |
| `src/workflow-jobs.ts` | Background jobs: launch at once, live counters, cancel. |
| `src/workflow-journal.ts` | Append-only JSONL, redacted, pruned, readable after a crash. |
| `src/workflow-slots.ts` | One slot pool for the whole process. |

Tests: `test/workflow-runtime.test.ts`, `test/workflow-tool.test.ts`,
`test/workflow-notice.test.ts`, `test/workflow-glyphs.test.ts`,
`test/workflow-jobs.test.ts`, `test/workflow-journal.test.ts`,
`test/workflow-background.test.ts`. Real-model E2E:
`scripts/workflow-e2e.ts` (`QRONOS_E2E_MODEL=claude-haiku-5.5`). They use a fake agent, so they spend no tokens
and take no seconds.
