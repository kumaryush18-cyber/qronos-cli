# Compaction

One long session fills the context window. Compaction replaces the oldest part
of the conversation with a checkpoint summary, so work can continue.

pi already does this. Qronos replaces that single summarization call with a
better one, and keeps pi's version as the fallback. **It is on by default** and
costs no extra model call: one call happens either way.

```
/compact              compact now
/compact focus on api keep the schema notes   compact with your own focus
```

The footer shows the result: `compacted 48k → 3.1k tokens`.

## Why replace it

A model-written summary is prose, and prose quietly drops exact strings: the
failing test name, the exit code, the path of the file that was edited. Those
are the things the next turn needs most.

So compaction here works in three steps:

1. **Prune first (no model).** A 30k-token tool dump becomes 700 characters:
   400 from the head, 300 from the tail. Assistant text and user messages are
   clamped too, and the whole transcript has a hard cap (`36,000` characters,
   newest turns kept).
2. **Record facts with code.** Every file path, shell command and error line is
   pulled out by plain code into an `## Exact Evidence` block. No model can lose
   them, because no model produced them.
3. **Ask for a shape.** The model must answer with seven fixed headings. A
   checkpoint missing four of them is rejected.

Then, before anything is stored: **secrets are redacted**, because a checkpoint
is re-sent to the provider on every later prompt. A key pasted into the chat must
not ride along forever.

## What a checkpoint looks like

Real output from `scripts/compact-e2e.ts` (glm-5.3-flash, 1,056 characters):

```
## Goal
- Read `src/sum.ts` and say in one line what it does, without changing any file.

## Constraints & Preferences
- Do not change any file for the first request.

## Progress
- [x] Read `src/sum.ts`.
- [x] Added a short comment above the function.

## Key Decisions
- **Added a comment above `sum`**: the user explicitly requested it.

## Errors & Open Questions
- (none)

## Next Steps
1. Wait for the user's next instruction.

## Critical Context
- File touched: `src/sum.ts`.
- Original line: `export function sum(a: number, b: number) { return a + b; }`

## Exact Evidence (recorded by the tool layer, not paraphrased)
Files touched:
- src/sum.ts
```

## The failure policy

Compaction runs exactly when the conversation cannot continue without it. A
broken summary at that moment would be fatal, so every failure has a way out.

| Situation | Result |
|---|---|
| History is tiny (< 6 messages) | extension does nothing; pi compacts as usual |
| Another summary already running | pi's own path runs |
| Model error or 503 | status `kept built-in summary (...)`, pi compacts |
| Timeout (default 120 s) | same as above |
| Answer missing 4+ headings | rejected, pi compacts |
| Answer is nearly empty | rejected, pi compacts |
| No auth for the model | still attempted (local models need none) |
| No keep boundary in the event | not offered; pi compacts |
| `QRONOS_COMPACT=0` | extension is a no-op |

"Return `{}`" is the whole trick: pi reads it as *no opinion* and does what it
always did. The extension can only make compaction better, never break it.

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `QRONOS_COMPACT` | on | `0` disables; pi's own summary is used |
| `QRONOS_COMPACT_MODEL` | session model | a cheaper model for the checkpoint |
| `QRONOS_COMPACT_TIMEOUT_MS` | `120000` | minimum accepted value is 10 s |
| `QRONOS_COMPACT_MIN_MESSAGES` | `6` | below this, leave compaction to pi |

## What is stored with the checkpoint

The compaction entry keeps `details`:

```json
{
  "source": "qronos-compact",
  "evidence": { "files": ["src/sum.ts"], "commands": [], "errors": [] },
  "stats": { "messages": 9, "toolCalls": 2, "charsIn": 8123, "charsOut": 640, "transcriptChars": 2210 }
}
```

So the session file itself explains what the checkpoint was built from.

## Files

```
src/compact-digest.ts      pruning, evidence, transcript (pure, no model)
src/compact-input.ts       digest + evidence built from the same messages
src/compact-summary.ts     prompt, heading validation, redaction, status line
src/compact-extension.ts   pi wiring: session_before_compact
```

## Tests

| Suite | Count |
|---|---|
| `test/compact-digest.test.ts` | 32 |
| `test/compact-summary.test.ts` | 27 |
| `test/compact-extension.test.ts` | 24 |
| **total** | **83** |

Plus a real-model check that summarises a real session:

```sh
QRONOS_E2E_MODEL=glm-5.3-flash bun run scripts/compact-e2e.ts
```

It runs two real turns, then summarises the real history, prints the checkpoint,
and fails if the file path was lost or a secret survived.
