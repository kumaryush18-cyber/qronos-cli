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

## Pause and resume

A run can be stopped halfway and finished later. There are two different things
here, and Claude Code separates them too:

### Pause a live run: nothing is replayed

```
/workflows pause wf_qhj6qy01     # no new agent starts; the ones in flight finish
/workflows resume wf_qhj6qy01    # it carries on from exactly where it was
```

Pausing stops **starting** new agents. An agent already talking to the model is
allowed to finish, because killing it would throw away tokens already paid for.
The wall clock stops with the run, so a run paused overnight keeps its full ten
minutes.

The status line shows `⏸` while a run is paused.

### Resume a run that is not live any more: replay

If the process ended, the run was stopped with `/workflows stop`, or the machine
crashed, the run is not in memory any more. It is on disk, though, and it can be
replayed:

```
/workflows saved                 # runs on disk, oldest last
/workflows resume wf_qhj6qy01    # replay it
```

A resume runs the **same script** again from the top. Every finished agent whose
request has not changed is answered from the journal instead of the model, so it
costs nothing again. The report says so: `· ↺ 3 replayed`.

The exact rules, which are Claude Code's rules:

1. A call is matched by **position**: its scope plus its number inside that scope.
   Two runs of one script ask for the same positions in the same order.
2. A saved answer is used only when the request is unchanged: same prompt, same
   agent type, same model. Change any of them and that call runs live.
3. The **first changed or failed call ends the saved region** for that scope.
   Everything after it runs live, because a script that shifted one prompt has
   shifted everything after it, and mixing two runs into one result would be a
   lie in the shape of a report.
4. A recorded **failure is not replayed**. Redoing a failed step is the point of
   resuming.
5. A call that never finished does not end the saved region. In a parallel
   fan-out a later call can finish first, and its answer is still good.

A resumed run gets a new job id and its own journal, which records
`resumedFrom: <old id>`. The old journal is never rewritten.

### Why the script must repeat itself

Replay is only honest if the second run makes the same decisions as the first.
So inside a workflow script:

- `Date.now()` and `new Date()` are **frozen at the run's start time**.
- `Math.random()` is a **seeded generator**, so it repeats.
- `Object.keys` and friends keep their order, which JavaScript already promises.

Claude Code goes one step further and makes `Date.now()` and `Math.random()`
**throw**. We keep them working but frozen: a replay is still exact, and a script
that stamps a report or shuffles a list keeps working. This is the one place
where we deliberately differ, and it is in our favour.

The script also still accepts explicit arguments, so `new Date(0)` and
`new Date("2020-01-01")` format a known moment normally.

### Cost

A replayed agent spends no tokens. The report counts only what this attempt paid:
`tokens` is fresh spend, `replayedTokens` is what the earlier attempt had already
paid for. Both numbers are shown, so nobody has to guess.

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
outlives the session that made it. Answers are capped at 4 000 characters. Each
`agent_end` line also carries the stable call key (`#3`, `w0/#1`), its scope and
position, a hash of the request, and whether it was replayed — that is exactly
what a later resume needs.

Old journals are pruned: the newest 20 runs are always kept, anything older than
7 days is removed, and the folder never grows past 200 files.

## Before it runs: the approval card

A workflow can spend a lot of tokens in a few seconds, so a run of three or more
written agent calls asks first. The card shows the plan, the cost, and the three
answers Claude Code offers:

```
╭──────────────────────────────────────────────────────────────────────╮
│ Run a dynamic workflow?                                  map the tree│
│  study the source tree by purpose using 5 parallel subagents          │
│                                                                      │
│  This will start subagents in 2 phases:                              │
│  1. Analyze — 5 agents                                               │
│     · "one file each"                                                │
│  2. Review                                                           │
│                                                                      │
│  ! 5 agent calls written in the script. About 12,000 tokens last time.│
│    Stop a run at any time with /workflows, or turn these             │
│    questions off with QRONOS_WORKFLOW_APPROVE=0.                     │
│                                                                      │
│  ▸ 1. Yes, run it  (uses tokens)                                     │
│    2. View raw script  (nothing runs)                                │
│    3. No  (nothing runs)                                             │
│                                                                      │
│  enter choose · 1 2 3 pick · tab amend · ctrl+g edit in $EDITOR      │
│  esc cancel · nothing runs unless you say yes                        │
╰──────────────────────────────────────────────────────────────────────╯
```

| Key | What it does |
|---|---|
| `1` `2` `3` | Pick an answer. `2` shows the script and changes nothing. |
| `enter` | Confirm the highlighted answer. |
| `↑` `↓` | Move the highlight. |
| `tab` | Amend the description. Type a better one, `enter` keeps it and runs. |
| `ctrl+g` | Open the script in `$VISUAL` / `$EDITOR`, then re-read it when you save. |
| `esc` | Cancel. From the script view it goes back to the question. |

Five rules the card keeps:

1. **Reading the plan never runs the code.** The phases come from a brace scan of
   `export const meta`, then a JSON parse. No `vm`, no evaluation.
2. **`esc` and "No" cost nothing.** Nothing is launched, nothing is journalled.
   The tool reports that the run was not started, so the model cannot pretend it
   happened.
3. **No terminal means no question.** In a test, a script or an E2E run the card
   is skipped and the run goes ahead. A guard that blocks headless use is worse
   than no guard.
4. **A resume is not asked about twice.** `resumeFrom` replays a script the user
   already approved.
5. **The estimate is labelled as an estimate.** It counts `agent(` calls in the
   source plus a factor for `parallel` and `pipeline`, so a loop is a lower
   bound. The card says "written in the script", not "will spend".

`QRONOS_WORKFLOW_APPROVE` decides when the card appears:

| Value | Behaviour |
|---|---|
| *(unset)*, `1`, `ask`, `auto` | Ask from three written agent calls, or a declared plan of three, or two phases. |
| `always`, `yes` | Ask for every run, even one agent. |
| `0`, `off`, `never`, `no` | Never ask. |

### Declaring the plan

A script can describe itself, so the card can show real phases instead of a guess:

```js
export const meta = {
  name: "audit routes",
  description: "check every route for a missing session check",
  phases: [
    { title: "Understand", agents: 4, prompt: "one route file each" },
    { title: "Review" },
  ],
}

phase("Understand")
const files = await parallel(ROUTES.map((route) => () => agent(`Read ${route}.`, { label: route })))
phase("Review")
return files.map((file) => file.text)
```

`phases` is for display only. A string entry is a title; an object may carry
`title` (or `name` / `phase`), `agents` (or `count`) and `prompt` (or `task` /
`example`). Up to twelve phases are kept; anything that is not a title is
dropped rather than guessed.

## The live panel

`Alt+W`, or `/workflows panel`, opens a floating panel in the middle of the
screen. It is the same shape as the Agent Hub (`Alt+A`), and for the same
reason: a workflow can run for ten minutes, and a command that prints a snapshot
is not the same as watching it.

```
╭──────────────────────────────────────────────────────────────────────╮
│auth-audit              3 running · 9 done · 42.1k tokens · 2m 05s    │
│  ┆ running · hj6qy01                                                  │
│                                                                      │
│  ▸ Understand       4 agents          ███                12.1k        │
│  ▸ Review           8 agents   ✗ 1    ██████████         31.4k        │
│                                                                      │
│  ▸ ✻ routes.ts                    ████████       7.1k  00:19         │
│  ┆ ✓ middleware.ts                ██████         5.0k  00:12         │
│  ┆ ↺ db.ts                        ██████         5.0k   skip replayed│
│  ┆ ✗ auth.ts                      ██             1.2k  00:04         │
│       no answer from the model                                        │
│                                                                      │
│ space pause · x stop · enter agent · ↑↓ job · esc close               │
│  wf_hj6qy01 · journal on disk                                        │
╰──────────────────────────────────────────────────────────────────────╯
```

How to read it:

- The first line is the run: its name, what is happening now, and the cost in
  tokens and time.
- Phase rows have a bar of their tokens, so the expensive stage is obvious.
  The phase that is working right now carries the **same 3 s pale-orange band**
  that flows through the header and the working line. One moving light means one
  thing everywhere in the CLI: this is happening now.
- Agent rows are sorted the way you look at them: still working first, then
  failures, then the ones that cost the most. A bright green `✓` is done, a dark
  red `✗` failed, a blue `↺` was answered from the journal and cost nothing.
- A running agent's time counts up while you watch.

Keys:

| Key | What it does |
|---|---|
| `space` | Pause a running run, or resume a paused one. Nothing is replayed by a live resume. |
| `x` | Stop the run. Agents in flight are cancelled. |
| `enter` | Open one agent: its phase, cost, time, error and answer. |
| `↑` `↓` | Move between runs (or between agents inside one agent's view). |
| `r` | Replay a finished run from its journal, without leaving the panel. |
| `esc` | Back out of an agent, or close the panel. |

Three rules the panel keeps:

1. **It only reads.** It holds no job of its own, so closing it can never lose a
   run. Everything it can do is also a `/workflows` command.
2. **The ticker stops.** Redrawing costs terminal time; the panel redraws every
   120 ms only while a run is live, draws one last frame when the last run ends,
   and then stops.
3. **It says how much of a run you are seeing.** `12 more` is printed when there
   are more agents than rows, so nothing is silently cut.

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
| `src/workflow-replay.ts` | Match a call by position, replay saved answers, respect the change boundary. |
| `src/workflow-clock.ts` | The pausable wall clock, and the frozen clock the script sees. |
| `src/workflow-panel.ts` | The overlay: box, colour, shimmer, keys, and the ticker that stops. |
| `src/workflow-panel-view.ts` | The panel's text, pure: header, phases, agent rows, agent view. |
| `src/workflow-approval.ts` | The question before a run: plan preview, cost, three answers, `$EDITOR`. |

Tests: `test/workflow-runtime.test.ts`, `test/workflow-tool.test.ts`,
`test/workflow-notice.test.ts`, `test/workflow-glyphs.test.ts`,
`test/workflow-jobs.test.ts`, `test/workflow-journal.test.ts`,
`test/workflow-background.test.ts`, `test/workflow-replay.test.ts`,
`test/workflow-clock.test.ts`, `test/workflow-pause.test.ts`,
`test/workflow-resume.test.ts`, `test/workflow-panel-view.test.ts`,
`test/workflow-panel.test.ts`, `test/workflow-approval.test.ts`. Real-model E2E: `scripts/workflow-e2e.ts` and
`scripts/workflow-panel-e2e.ts` (`QRONOS_E2E_MODEL=claude-haiku-5.5`). They use a fake agent, so they spend no tokens
and take no seconds.
