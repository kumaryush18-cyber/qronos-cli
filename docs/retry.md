# Retries

A model request can fail for a reason that fixes itself: the model is busy, the
gateway blips, the connection drops before a single byte arrives. Until now one
such hiccup ended a subagent at once, and the main chat gave up after 2 s, 4 s,
8 s.

Both paths now retry up to **10 times** and say so while they wait.

## The schedule

| Retry | Subagent (`src/retry.ts`) | Main chat (pi engine setting) |
|---|---|---|
| 1 | 10 s | 10 s |
| 2 | 30 s | 20 s |
| 3 | 60 s | 40 s |
| 4 … 10 | 60 s | 60 s |

Subagents keep an exact list (10, 30, 60, 60 …). The main chat lives inside pi,
whose backoff is exponential (`base × 2^n`) with a cap, so the same four numbers
are expressed as a 10 s base and a 60 s cap. The shape is the same: small early
waits, then every 60 s.

Worst case is about 7 minutes of waiting before the error is shown. That is the
point: a temporary outage should not cost you the task.

## What is retried

| Retried | Never retried |
|---|---|
| `model temporarily unavailable`, 529 overloaded, 5xx | token/quota exhausted (`402`, `insufficient_quota`) |
| 429 temporary throttle | bad or missing API key (`401`, `403`) |
| timeouts and dropped connections **before any output** | TLS certificate problems |
| network errors (`fetch failed`, `ENOTFOUND`, `socket hang up`) | content policy denials |

An **unknown** error is not retried. Guessing costs minutes and hides the cause;
Claude Code behaves the same way.

## Two rules that matter more than the numbers

1. **Nothing is replayed after work was done.** `canRetry` is checked before every
   wait. Once text has streamed or a tool call has started, the failure surfaces
   instead of risking the same tool running twice.
2. **The session model is tried last.** A subagent falls back to the parent's
   model only after every retry is used, so a five-second blip never silently
   changes which model answered.

## What you see

- **Main chat**: pi's own line, `Retrying (2/10) in 20s... (esc to cancel)`.
- **Subagent roster**: the row reads `retrying (2/10)`.
- **Subagent chat**: a notice line in the log, plus
  `✻ retrying in 30s · attempt 2/10` above the key hints.
- Escape during a wait stops immediately.

## Environment

| Variable | Default | Effect |
|---|---|---|
| `QRONOS_RETRY` | `1` | `0` turns retries off everywhere |
| `QRONOS_MAX_RETRIES` | `10` | retries after the first try, capped at 15 |
| `QRONOS_RETRY_SCHEDULE` | `10,30,60` | seconds, last value repeats |
| `QRONOS_RETRY_MAX_WAIT_MS` | `60000` | hard cap for one wait (also main chat's cap) |

## Tests

`test/retry.test.ts` — 27 tests: the default schedule, the cap, env parsing,
every retryable and non-retryable wording, the exact waits, the notices, abort
during a wait, "work already done is never replayed", and the main-chat settings
built from the same environment.
