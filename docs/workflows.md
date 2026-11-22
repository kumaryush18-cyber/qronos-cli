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
- `/workflows stop wf_qhj6qy01 alpha` — stops **one** agent; the run carries on.
- `/workflows rerun wf_qhj6qy01 Look` — runs **every** agent of that phase again.
- `/workflows retry wf_qhj6qy01` — runs the **failed** agents again, and only those.

If the caller needs the value **inside the same turn**, it can pass
`background: false`; the tool then waits and returns the report directly. That is
what the tests and `scripts/workflow-e2e.ts` use.

Background jobs and chat subagents draw from **one** slot pool, so a background
workflow can never double the concurrency limit behind your back.

## Retrying what failed

After a big run there are usually two or three red crosses and a dozen good
answers. Rerunning everything pays twice for work that is already right;
rerunning nothing leaves holes in the report.

```
/workflows retry wf_qhj6qy01           # every failed agent, one at a time
```

In the panel, `f` does the same.

The rules are the phase rerun's, at the size of "only what broke":

1. **It asks first.** The card says how many failed, their names, and what they
   spent the first time. Cursor on No, no overlay means No, and no spends nothing.
2. **New work, not a replay.** The tokens rise and the rows say they ran again.
3. **One at a time**, so the bill stays readable.

And one rule of its own: **a stopped agent is not a failed one.** You stopped it on
purpose, so `f` leaves it alone. If the only agents that did not finish are the
ones you stopped, the answer is not "nothing failed" — it says that they were
stopped by you.

A retry that fails again is not a reason to stop: the record keeps its new
attempt, the report shows the work that was really done, and the notice says how
many ran and which one did not.

## Running a phase again

The code under a phase changed, so every agent in that phase read a file that is
no longer true. Doing that by hand is `r`, wait, `↑`, `r`, wait — which nobody
does correctly.

```
/workflows rerun wf_qhj6qy01 Look      # every agent of the phase, one at a time
```

In the panel, `a` does the same for the phase under the cursor. It is a different
size of decision from `r` (one agent) and `x` (the whole run), so it has its own
key.

Three rules, the same three as a single restart:

1. **It asks first.** The card names the phase, how many agents, and what they
   spent the first time. The cursor starts on No, and no overlay means No.
2. **It is new work, not a replay.** The tokens rise and every row says it ran
   again. A report must never pass old work off as new.
3. **It never runs two at once.** One agent finishes before the next starts, so
   the bill stays readable and the one-restart-at-a-time guard stays true.

One agent that cannot run does not stop the rest: the phase is a set of separate
questions, so the others still run, and the notice says how many ran and which
one did not.

## Stopping one agent

There are two sizes of stop, and they are not the same decision:

```
/workflows stop wf_qhj6qy01            # the whole run: nothing else starts
/workflows stop wf_qhj6qy01 alpha      # one agent: the rest keeps going
```

In the panel, `x` stops the run and `k` stops the agent you are looking at. The
word may be an id (`#3`, or just `3`) or part of the label (`alpha`). A word that
names two agents is refused with the list, because stopping the wrong one spends
money on the wrong work.

What a stop costs, and what it does not:

| | Tokens already spent | Tokens not spent |
|---|---|---|
| Stopped agent | **kept on the bill** | saved |
| Rest of the run | unaffected | spends as usual |

A stopped agent is **not a failure**. The script sees an ordinary answer —
`{ ok: false, error: "stopped by you" }` — so it can decide what to do with it,
and the panel, the report and the summary write `⊘ stopped by you` rather than a
red cross. The failure count stays at zero, because nothing broke: you decided.

A stop saves the **rest** of a call, never the call. That is why `x` and `k` are
different keys: a run is one decision, one agent is a smaller one.

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

### A script you saved, run again tomorrow

`s` writes a script into `<project>/.qronos/workflows/<name>.js`, so it can live in
git next to the code it describes. Saving is only half of it: three commands read
those files back.

```
/workflows scripts        # what is saved: name, size, when it was last written
/workflows run review     # run one
/workflows edit review    # change one, and save the change only if you say so
```

`run` **does not start the run by itself**, and that is deliberate: a command
handler cannot run tools, and a workflow whose agents cannot read or write is a
workflow that fails. So the command checks the file, then asks the chat's own
agent to call the `workflow` tool with `scriptFile: "<path>"`. The tool reads the
file, so the text that runs is the text on disk — nothing is retyped, and nothing
can drift. The usual approval card comes first and names the script.

`edit` opens the file in `$VISUAL` / `$EDITOR`, and then asks:

```
╭──────────────────────────────────────────────────────────────╮
│ Save the change?                                             │
│   .qronos/workflows/review.js                                │
│   the file on disk would be replaced                         │
│   ▸ 1. Yes, save it                                          │
│     2. No, leave the file alone                              │
╰──────────────────────────────────────────────────────────────╯
```

The cursor starts on **No**, closing the card means No, and a host with no
overlay means No. An edited workspace file is never written in silence.

Names are forgiving in one narrow way: an exact name, an exact file name, or the
slug form all find the same file, so `Review`, `review.js` and `review` are one
script. Anything else is "no such script", with the list — guessing which script
someone meant is worse than saying no.

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

It is two columns: the phases of the run on the left, the agents of the phase you
are pointing at on the right. One long mixed list made you scroll to connect a
phase with its work; a column each means the connection is on the same line.

```
╭──────────────────────────────────────────────────────────────────────╮
│analyze-src                              2/5 agents · 1m 05s          │
│Map the source tree by purpose using 5 parallel subagents             │
│  1 failed · 1 replayed · 42.1k tokens                                │
│                                                                      │
│Phases                       │ Analyze · 5 agents                     │
│▸ 1 Analyze 2/5              │ ✻ coding-agent  deepseek-v4 · 0 tokens 29s
│                             │ ✻ ai-and-tui    deepseek-v4 · 0 tokens 29s
│                             │ ↻ waiting                        queued│
│                             │ ↻ waiting                        queued│
│                             │ ↻ waiting                        queued│
│                                                                      │
│p pause · x stop · s save · enter view · ↑↓ phase · tab run · esc close│
│  wf_hj6qy01 · journal on disk                                        │
╰──────────────────────────────────────────────────────────────────────╯
```

How to read it:

- **The first line is the run.** Its name on the left; on the right, how many
  agents have finished out of how many the script planned, and how long it has
  been going. `2/5` counts finished agents, not started ones, so it never runs
  backwards.
- **The second line is what the script says it does**, taken from
  `meta.description`. If the script declares no description, the line is left
  out.
- **The third line is the detail that matters**: failures, replays and the
  token bill. It is only there when there is something to say.
- **The phases column** is the map of the run: `▸` is where the cursor is, the
  number is the phase's place, and `2/5` is finished out of planned.
- **The agents column** shows one row per agent of the selected phase: a glyph,
  the label, the model, the tokens and the time. Rows are sorted the way you
  look at them: still working first, then failures, then the ones that cost the
  most.
- **Queued rows** are agents the plan promised and the script has not started
  yet. Their name is unknown until they start, so the row says `waiting` and the
  right-hand side says `queued`.
- The phase that is working right now carries the **same 3 s pale-orange band**
  that flows through the header and the working line. One moving light means one
  thing everywhere in the CLI: this is happening now.

What the panel knows about one agent:

- **The task it was given.** Redacted and capped at 1 200 characters, kept from
  the moment the agent starts, so a live agent can show what it was asked.
- **Its tool calls.** The count always rises; the kept rows stop at the last
  eight, which is what a person actually reads. Each row carries the tool name
  and the first line of its arguments, redacted first and then cut at 80
  characters, so a cut can never leave half a secret behind.
- **Its model**, when the script routed it to one.

Activity is display-only and is never written to the journal: a journal that
grows with every tool call is slow to read and expensive to keep. A resumed run
still shows the task, and the tool count arrives with the agent's own record.

Keys:

| Key | What it does |
|---|---|
| `p` | Pause a running run, or resume a paused one. Nothing is replayed by a live resume. `space` does the same. |
| `x` | Stop the run. Agents in flight are cancelled. |
| `k` | Inside one agent, stop **that** agent and leave the run alone. The tokens it already spent stay on the bill, and the row says `⊘ Stopped by you`, never `failed`. |
| `s` | Save the script to `<project>/.qronos/workflows/<name>.js`, so a good run can be used again tomorrow. An existing file is never overwritten: the new one gets `-2`, `-3`. |
| `enter` | Open one agent: its task, its tool calls and its outcome. Inside that screen, `enter` opens or closes the block under the cursor. |
| `↑` `↓` | Move between phases; the right column follows. Inside one agent, move between the agents of its phase. |
| `←` `→` | Move between the agents of the phase. |
| `tab` | Move to the next run, when there is more than one. Inside one agent, move the cursor between Prompt, Activity and Outcome. |
| `a` | Run **every** agent of the phase under the cursor again, one at a time. The card comes first, because this spends money once per agent. |
| `f` | Run every **failed** agent again, and only those. A stopped agent is not a failed one, so it is left alone. |
| `r` | Replay a finished run from its journal, without leaving the panel. |
| `esc` | Back out of an agent, or close the panel. |

Every key is also a command, because a floating panel must never be the only way
to do something: `p` is `/workflows pause`, `x` is `/workflows stop`, `s` is
`/workflows save`, and `r` is `/workflows resume` on a saved run. `k` is the one
exception in the other direction: it is `/workflows stop <id> <agent>`, because a
word in a command needs an id and the panel already knows which agent you mean. The scripts on
disk have commands of their own: `/workflows scripts`, `run <name>` and
`edit <name>`.

### One agent, in full

`enter` on an agent opens its own screen. The left column stays, because after
reading a long task you still want to know which agent you are reading about;
the right column is that agent's story, in three blocks.

```
╭──────────────────────────────────────────────────────────────────────╮
│Agents · Analyze             coding-agent                  ● Running  │
│▸ ● coding-agent            │ ernie-5.5-flash-preview                  │
│  ✗ ai-and-tui              │ 0 tokens · 6 tools · idle 1m 01s          │
│                             │                                          │
│                             │ ▸ Prompt · 7 lines · ↵ expand            │
│                             │   Area: TypeScript coding agent core.     │
│                             │   Read package.json and skim the files.  │
│                             │   … 5 more lines                         │
│                             │                                          │
│                             │   Activity · last 3 of 6 · ↵ expand      │
│                             │   Bash(cd src && wc -l index.ts)         │
│                             │   read(path: package.json)               │
│                             │   grep(pattern: tool) · now              │
│                             │                                          │
│                             │   Outcome                                │
│                             │   Still running…                         │
│                                                                      │
│↑↓ agent · tab block · enter expand · p pause · x stop · esc back      │
╰──────────────────────────────────────────────────────────────────────╯
```

- **The header** is the agent's name and what it is doing: `● Running`,
  `✓ Done`, `✗ Failed`, `↺ Replayed`, or `✓ Done · restarted` for one you ran
  again. The glyph is the same one the list uses, so the two screens never
  disagree.
- **The model line** carries the context size when the model reports one:
  `claude-haiku-5.5 [1m]`. It answers a real question at a glance — did this
  agent have room to read the whole file, or did it work blind? An unknown size
  shows the name alone; an invented number would be worse than none.
- **The facts line** is the bill and the clock: tokens, how many tool calls, and
  either `idle 1m 01s` for an agent that is still working or `took 29s` for one
  that is finished. Idle counts from the last tool call, which is the question
  you actually have when an agent looks stuck.
- **Prompt** is what the agent was asked, two lines at a time. The heading says
  how many lines it really is, and `… 5 more lines` says how much is folded
  away. A prompt that was never kept says `not kept` instead of pretending.
- **Activity** is the last three tool calls with the first line of their
  arguments, so a row reads `read(path: package.json)` and not just `read`. The
  heading says `last 3 of 6`, so a cut list is never mistaken for the whole list.
  The newest call of a working agent carries `· now`.
- **Outcome** is `Still running…`, the error, or the answer. An answer that the
  session did not keep says so; it is not left blank.

`tab` moves the cursor between the three blocks and `enter` opens the one under
it. Blocks are closed when you arrive, because a long task would otherwise push
the keys off the screen the moment you press `enter`. `p` and `x` still work
here: it is the same run, and a screen that hides the controls of the run you
are watching is a dead end.

`r` means **"run this agent again"** inside this screen, and "replay this run"
on the list screen — the screen you are looking at decides which agent it is
about.

The arrows move between the agents of the phase, and `esc` goes back to the
phases. Queued agents are not in this list, because there is nothing to show
for one yet.

Four rules the panel keeps:

1. **It only reads.** It holds no job of its own, so closing it can never lose a
   run. Everything it can do is also a `/workflows` command.
2. **The ticker stops.** Redrawing costs terminal time; the panel redraws every
   120 ms only while a run is live, draws one last frame when the last run ends,
   and then stops.
3. **It says how much of a run you are seeing.** `… 6 more agents in Analyze` is
   printed when a phase has more agents than rows, so nothing is silently cut.
4. **A live run is never called failed.** A run with a live agent shows the
   working mark, however many agents have already failed.

### Running one agent again

Sometimes one agent misses the point and the other eleven were fine. `r` on that
agent runs it again, with the same words, model and phase, and changes nothing
else in the run.

It costs tokens, so it asks first:

```
╭────────────────────────────────────────────────────────────────╮
│ Run this agent again?                                          │
│                                                                │
│   coding-agent                                                 │
│   claude-haiku-5.5 · 4300 tokens last time                     │
│                                                                │
│   Read the parser and find the bug.                            │
│                                                                │
│   this calls the model again and spends tokens again           │
│   the rest of the run is not touched                           │
│                                                                │
│   ▸ 1. Yes, run it again                                       │
│     2. Edit the task, then run it                              │
│     3. No                                                      │
│                                                                │
│   enter choose · y yes · e edit · esc no                        │
╰────────────────────────────────────────────────────────────────╯
```

The cursor starts on **No** and closing the card means No, so silence never
spends anything. `/workflows restart <id> <agent>` is the same thing from a
command, and the two cannot drift: one function asks, one function runs.

The second answer exists because usually the task was unclear, not the model was
wrong. `2` (or `e`) opens the task for typing in the card, `ctrl+g` opens your
`$EDITOR` on it, `enter` runs the words as they stand, and `esc` goes back to the
answers without running anything. The card marks a changed task with
`edited, not the task it had before`, so a change is never invisible, and the
detail view then shows `Prompt · edited` and `attempt 2 · ran again 1 time`.

What a restart does, and what it refuses:

- **It never lies about the bill.** `tokens` goes up by what the second attempt
  cost, and `replayedTokens` does not move: a restart is new work, not a replay.
  The row says `✓ Done · restarted`, so a cheaper-looking report cannot hide it.
- **The other agents are not touched.** Only the chosen record changes, which is
  why the code that writes it is one small function.
- **Old tool rows go.** They belong to the old attempt, and showing them beside a
  new answer would invite the wrong conclusion.
- **A live run is refused**, with a line that says why: two agents must not spend
  on the same job at once. Stop the run, then restart an agent.
- **The prompt is the one that was kept**, which is redacted and capped. If the
  session kept none, the restart says so rather than inventing a task. A task you
  edit for the restart becomes the kept one, so the Prompt block never shows words
  that were not really sent.
- **Each attempt is written down.** The record keeps the last five: when it ran,
  whether it worked, what it cost, and the task when you changed it. A report can
  therefore never pass attempt three off as attempt one.
- **The same agent cannot be started twice at once.** The key is guarded, so a
  double keypress is one call, not two.

### While it runs: the waiting row

A background run outlives the turn that started it. The answer arrives, the
working line stops, and the run keeps going — so the CLI needs a second row, one
that belongs to the run and not to the turn:

```
※ Waiting for 1 dynamic workflow to finish
```

- The words are Claude Code's. The count is in plain English: `1 dynamic
  workflow`, `3 dynamic workflows`. It goes away the moment the last run ends.
- The `※` breathes and the same 3 s pale-orange band flows through the words as
  through the header and the working line. One moving light means one thing in
  the whole CLI: this is happening now. A line that lives for ten minutes and
  never moves looks like a frozen terminal.
- The row sits **below** the working line and **above** the editor, so both can
  be true at once: the assistant is answering and a workflow is running.
- **The ticker stops.** It redraws every 150 ms only while something is waiting.
  When the count reaches zero it draws one last empty frame and stops. A quiet
  CLI must not spend the battery of a busy one.
- The row only knows a **number**. It cannot start, stop, pause or read a run.
  That is why it can never cost a token or lose work: the work is in the job
  manager, and the row is told how many jobs are live.

The count comes from the job manager itself (`onActiveChange`), not from the
places that start and stop runs. One hook means one place to be right, so a run
that ends by being cancelled from the panel cannot leave the row behind.

### When the panel closes

```
└ Dynamic workflows dialog dismissed
```

One muted line, in the transcript, at the weight of a footnote. It is a **custom
entry**, not a message: it is drawn for you and never sent to the model, so
closing a dialog cannot wake the assistant up or spend a token. If a host cannot
draw entries, the line is simply absent — never an error.

### The table at the end

A fan-out answers the same questions about N things. Prose makes the reader
compare five paragraphs by eye; a table makes the shape of the answer visible:

```
results:
#             │ project      │ about
──────────────┼──────────────┼───────────────────────────
coding-agent  │ coding-agent │ the agent loop
ai-and-tui    │ ai-and-tui   │ providers and the TUI
```

- It appears when **at least two agents returned structured data** — that is,
  when the script asked for a `schema` and the answer passed the check.
- Columns are the keys the agents agreed on, in the order they first appeared.
  A key only one agent used is still a column, with a gap: a gap says "this one
  did not answer that", and a missing column would hide it.
- `#` is the agent's label, so every row can be traced back to a real agent.
- A cell is one line, cut at 28 characters with a visible `…`. A 200-character
  description would otherwise push the last column off the screen.
- Nothing is invented. A run with no structured data gets no table at all
  rather than an empty frame around nothing.

## Why a script, and not just many `agent` calls

A tool call returns its result into the conversation. Ten calls return ten
results. A script keeps intermediate results in **variables**, so only one value
survives. That single difference is what makes a big job affordable.

## What the script may use

Exactly five helpers. Nothing else exists inside the sandbox.

| Helper | What it does |
|---|---|
| `agent(prompt, { label?, schema?, model?, phase? })` | Runs one subagent. Resolves to `{ ok, text, data, error, usage }`. It never throws and never returns null: a failed agent is `{ ok: false, error }`, so check `r.ok`. |
| `parallel([...])` | Runs promises or functions at once. Order is kept. |
| `pipeline(list, item => ...)` | One task per item, limited to the allowed concurrency. |
| `phase("Review")` | Names a step. Agents and tokens are counted per phase. Call it once before a group of agents. |
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

### Naming a phase per agent

`phase("Review")` names everything that comes after it, which is right for a
straight script. A `parallel` map has no "after it", so an agent can name its
own phase:

```js
const AREAS = [
  { key: "routes", prompt: `Area: HTTP routes - src/routes. Group by purpose.` },
  { key: "db", prompt: `Area: database - src/db. Group by purpose.` },
]
phase("Analyze")
const out = await parallel(
  AREAS.map((a) => agent(a.prompt, { label: a.key, phase: "Analyze" })),
)
return { areas: out.filter((r) => r.ok), failed: AREAS.filter((_, i) => !out[i].ok).map((a) => a.key) }
```

Three rules that go with it:

- **`phase()` goes once, before the group.** Inside the map it would make one
  phase per agent, and the panel would show ten columns of one row.
- **A blank `phase` means "the current phase".** A script never has to repeat
  itself, and `phase: ""` is not a phase called nothing.
- **A slow agent keeps the phase it started in.** The name is resolved when the
  agent starts, so a script that moves on while agents are still running cannot
  file a row under the wrong column.

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

## Approving a tool inside a workflow

A subagent can use tools. Until now it used them without asking, which is fine
for a run of `read` and `grep`, and not fine for a run that can write and run
shell commands. So every tool call a subagent makes now meets **the chat's own
permission mode**, read at the moment the tool would run:

| Mode | reads | writes in the project | shell | destructive shell, write outside |
| --- | --- | --- | --- | --- |
| `auto` (default) | run | run | run | **ask** |
| `accept edits` | run | run | **ask** | **ask** |
| `manual` | run | **ask** | **ask** | **ask** |
| `plan` | run | refused | refused unless it only reads | refused |
| `skip permissions` | run | run | run | run |

The card appears in the **chat**, not in the panel, because the panel only reads:

```
╭──────────────────────────────────────────────────────────────────────╮
│ Bash command · from the "analyze-src" workflow                  1 of 3 │
│                                                                      │
│   $ cd src && ls                                                     │
│                                                                      │
│   ▸ 1. Yes                                                           │
│     2. Yes, allow shell commands for this run                        │
│     3. Yes, and switch to auto mode                                  │
│     4. No                                                            │
│                                                                      │
│   enter choose · 1 2 3 4 pick · esc cancel                           │
│   nothing runs unless you say yes                                    │
╰──────────────────────────────────────────────────────────────────────╯
```

Three rules, and each one is a test:

- **Closing the card without choosing means "No".** `esc` is an answer, and
  the answer is no. Silence must never run a tool.
- **"Allow for this run" dies with the run.** The grant is a `Set` on the run
  itself. It is never written to a file, never survives `/workflows resume`,
  and is gone the moment the run settles. A refused tool is not a crash: the
  subagent receives `No: <reason>` as the tool result, says what it wanted to
  do, and the run carries on.
- **There is no terminal, so there is no yes.** A headless run (`qronos -p`) has
  no way to ask, so a call the mode would question is refused instead of
  allowed. `auto` and `skip permissions` still work, because their rules never
  needed an answer.

### What a subagent may hold

A workflow agent gets **the same tool pool as the chat** — no wider, and no
narrower — because the door, not the tool list, is what decides whether a call
may run. Before this a workflow agent could only read: the builtin agent
definition carries a read-only allow-list, so `bash` and `write` were dropped
before the model ever saw them, and a door that nobody can reach guards nothing.

The listed set is still the intersection with the parent's pool, and four names
stay denied for every subagent (`workflow`, `agent`, `ask_user_question`,
`end_conversation`): recursion is governed by the depth limit, and only the top
level owns the conversation.

Set `QRONOS_WORKFLOW_TOOLS=0` to turn the door off and keep the old behaviour.

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
| `src/workflow-waiting.ts` | The `※ Waiting for N dynamic workflows` row, and its stop rule. |
| `src/workflow-note.ts` | The note after a run: what ended, what it cost, one line. |
| `src/workflow-table.ts` | The results table: phases, agents, tokens, failures, bars. |
| `src/workflow-save.ts` | `s` saves the script, never over an existing file. |
| `src/workflow-library.ts` | The saved scripts, read back: list, find by name, read. |
| `src/workflow-confirm.ts` | The small yes/no card, cursor on No. |
| `src/workflow-permissions.ts` | Which tool, how dangerous, allowed or not: one pure decision. |
| `src/workflow-card-style.ts` | The card's rows, colours and border, shared by both cards. |
| `src/workflow-tool-approval.ts` | The card that asks before a tool runs inside a run. |
| `src/workflow-context-size.ts` | `[1m]` / `[200k]`, and nothing at all when the size is unknown. |
| `src/workflow-restart.ts` | Run one agent again: the request, the refusals, the one write. |
| `src/workflow-restart-confirm.ts` | The card that asks before a restart, with the task editable. |
| `src/editor-edit.ts` | `$EDITOR` on a piece of text, once, with a path we made. |

Tests: `test/workflow-runtime.test.ts`, `test/workflow-tool.test.ts`,
`test/workflow-notice.test.ts`, `test/workflow-glyphs.test.ts`,
`test/workflow-jobs.test.ts`, `test/workflow-journal.test.ts`,
`test/workflow-background.test.ts`, `test/workflow-replay.test.ts`,
`test/workflow-clock.test.ts`, `test/workflow-pause.test.ts`,
`test/workflow-resume.test.ts`, `test/workflow-panel-view.test.ts`,
`test/workflow-panel.test.ts`, `test/workflow-approval.test.ts`,
`test/workflow-permissions.test.ts`, `test/workflow-tool-approval.test.ts`,
`test/workflow-tool-gate.test.ts`, `test/workflow-tool-gate-card.test.ts`,
`test/workflow-waiting.test.ts`, `test/workflow-note.test.ts`,
`test/workflow-table.test.ts`, `test/workflow-save.test.ts`,
`test/workflow-activity.test.ts`, `test/workflow-context-size.test.ts`,
`test/workflow-restart.test.ts`, `test/workflow-restart-confirm.test.ts`,
`test/workflow-library.test.ts`, `test/workflow-confirm.test.ts`,
`test/workflow-scripts-command.test.ts`, `test/editor-edit.test.ts`.

Real-model E2E, with `QRONOS_E2E_MODEL=claude-haiku-5.5`:

- `scripts/workflow-e2e.ts` — the runtime, with a fake agent: no tokens, no seconds.
- `scripts/workflow-panel-e2e.ts` — the two-column panel, the detail view, the keys.
- `scripts/workflow-tool-approval-e2e.ts` — the card stops a real `bash` call.
- `scripts/workflow-restart-e2e.ts` — a restart is refused once, then costs money.
- `scripts/workflow-scripts-e2e.ts` — a saved script is listed, run from disk, edited and saved.
