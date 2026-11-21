# Memory

Qronos remembers what it learns in a project, so the next session does not start
from zero. This is on by default: nothing to configure, nothing to install.

```
/memory            what is known about this project
/memory stats      counts, syncs, backlog
/memory sync       learn from the turns since last time (one model call)
/memory add ...    save a lesson by hand
/memory forget ... remove a lesson
/memory clear      delete this project's memory
```

The model also has a `learn` tool: when it works out something durable ("this
repo needs `bun test --bail` or the suite hangs"), it saves a one-line lesson
straight away.

## What it does, in four steps

| Step | When | Cost |
|---|---|---|
| **Journal** | end of every turn | free — a small local file |
| **Inject** | start of every prompt | free — a capped block of hints |
| **Learn** | when the model or you save a lesson | free |
| **Consolidate** | `/memory sync`, or in the background after enough turns | one small model call |

## Where it lives

```
~/.qronos/agent/memories/<project>-<hash>/
  MEMORY.md          curated doc: decisions, constraints, workflows, failures, preferences
  memory_summary.md  reserved compact summary
  learned.md         one-line lessons, newest first
  journal.jsonl      turns not yet consolidated
  state.json         counters, last sync, how far the journal was read
  lock               one consolidator at a time
```

The folder name is the repository root's name plus 8 hex characters of its
absolute path, so two projects both called `General` never share memory.
Nothing is written inside your repository, and nothing is sent anywhere: memory
is a local file.

## What gets injected

At the start of every prompt, a `Memory Guidance` section is added:

```
## Memory Guidance (learned from earlier sessions in this project)
These notes are hints from past work, not the current state of the repo.
If a note contradicts the code or the user, trust the code or the user, and say the note looks stale.
Full documents: .../MEMORY.md and .../learned.md — read them when a hint matters.
### Project memory
- Decisions: use bun for every script · no new DB tables
### Lessons
- the suite needs --bail or it hangs
Write a new durable fact with the `learn` tool; update the document with `/memory sync`.
```

Three deliberate choices:

1. **It says it is a hint.** Stale memory the agent trusts over the repo is worse
   than no memory.
2. **It has a hard budget** (`QRONOS_MEMORY_BUDGET`, default 1200 tokens). Pieces
   are added in priority order — header, sections, then lessons newest-first — and
   the loop stops at the cap. A project with a hundred lessons still costs about
   the same per prompt.
3. **No memory, no block.** A fresh project adds nothing at all.

## How a sync works

1. Take the journal rows after `state.lastSeq`, at most 10 rows, at most 14,000
   characters, newest rows winning when the cap trips.
2. One model call: the rows go in, five arrays come out. Items shorter than 12
   characters, longer than 200, or that look like a secret are dropped.
3. Merge locally: new items at the front of their section, duplicates folded
   (an item already known keeps its first wording), per-section caps applied.
4. Write `MEMORY.md` (atomic rename), delete the consumed rows, advance
   `state.lastSeq`.

### Failure policy — memory is never lost

| Situation | Result |
|---|---|
| Another sync is running | `busy`, nothing happens |
| Model error | `model-failed`; document and journal untouched |
| Empty or unparseable answer | retried **once**, then `bad-answer`; untouched |
| Answer with no durable items (`{}`) | rows consumed, document unchanged |
| Disk write fails | `write-failed`; state not advanced, so the next sync retries |
| Half-written file after a crash | impossible: writes go to `<file>.tmp` then rename |

An empty answer is the one failure a real model produces by accident — it was
seen live with `glm-5.3-flash` — which is why that case alone gets a second try.

## Background sync

At session start, 2.5 s later (never before your first prompt), the extension
checks whether a sync is worth a model call:

- at least `QRONOS_MEMORY_MIN_TURNS` new rows (default 6), and
- at least `QRONOS_MEMORY_INTERVAL_MIN` minutes since the last sync (default 30),
  or no sync has ever run for this project.

If both hold, one consolidation runs in the background. Failures stay silent:
a background model error is not something to interrupt you with. `/memory stats`
shows the result.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `QRONOS_MEMORY` | on | `0` turns memory off completely |
| `QRONOS_MEMORY_AUTO` | on | `0` keeps memory but never syncs in the background |
| `QRONOS_MEMORY_MODEL` | session model | model used for extraction |
| `QRONOS_MEMORY_BUDGET` | `1200` | approximate tokens injected per prompt (200–8000) |
| `QRONOS_MEMORY_MIN_TURNS` | `6` | new turns needed before an automatic sync |
| `QRONOS_MEMORY_INTERVAL_MIN` | `30` | minutes between automatic syncs |
| `QRONOS_MEMORY_STATUS` | on | `0` hides the `memory N` footer line |

## Secrets

Memory is the only feature that copies conversation text into a file that later
goes back into a prompt, so redaction runs on every write **and** on model
output: `sk-…`, `ghp_…`/`github_pat_…`, `AKIA…`/`ASIA…`, Slack, Stripe, Google
keys, Telegram bot tokens, JWTs, PEM private key blocks, `name=value` pairs whose
name says secret (`api_key`, `token`, `password`, …), `Bearer …` headers and
`user:pass@host` URL credentials. Redaction is idempotent, so a second pass
cannot grow the text. `test/secret-redact.test.ts` covers each shape plus the
false-positive cases ("token: none" survives).

## Files

```
src/memory-config.ts       settings from the environment
src/memory-paths.ts        project folder, repo root, file paths
src/memory-store.ts        atomic writes, state, lock, journal ring
src/memory-doc.ts          the five sections: parse, merge, render
src/memory-lessons.ts      learned.md
src/memory-journal.ts      one turn -> one row (redacted, clamped)
src/memory-inject.ts       the budgeted prompt block
src/memory-extract.ts      prompt + strict parsing of the model's JSON
src/memory-consolidate.ts  the write path and its failure policy
src/memory-extension.ts    pi wiring: events, `learn` tool, `/memory`
src/secret-redact.ts       the secret guard
```

## Tests

| Suite | Count |
|---|---|
| `test/secret-redact.test.ts` | 27 |
| `test/memory-paths.test.ts` | 16 |
| `test/memory-store.test.ts` | 29 |
| `test/memory-doc.test.ts` | 27 |
| `test/memory-lessons.test.ts` | 15 |
| `test/memory-journal.test.ts` | 20 |
| `test/memory-inject.test.ts` | 13 |
| `test/memory-extract.test.ts` | 27 |
| `test/memory-consolidate.test.ts` | 20 |
| `test/memory-config.test.ts` | 11 |
| `test/memory-extension.test.ts` | 31 |
| **total** | **236** |

Plus a real-model end-to-end check:

```sh
QRONOS_E2E_MODEL=glm-5.3-flash bun run scripts/memory-e2e.ts
```

It runs two real turns, journals them, consolidates with a real model, and
prints the resulting `MEMORY.md` and the block the next session would receive.
