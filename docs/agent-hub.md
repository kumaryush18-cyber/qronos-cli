# Agent Hub

Subagents already existed: `agent` runs a task in an isolated context, starts
read-only and needs `exit_plan_mode` approval before it may write. What was
missing was being able to *see* them (part A) and to *trust* what they return
(part B). Part C (below) turns the registry into a screen you can act on.

Nothing here is copied from another project. The behaviour is modelled on how
mature coding agents do it, but every line is ours, in TypeScript, with no new
dependencies.

## Part A — the registry (`src/agent-registry.ts`)

A plain state machine. No TUI, no timers, no I/O, so the awkward cases are unit
tested instead of discovered in the field.

| Field | Meaning |
|---|---|
| `id`, `index` | `agent-1`, `agent-2`, … in spawn order |
| `type` | Explore, Plan, General, or a custom `.qronos/agents/*.md` name |
| `status` | `running`, `waiting-approval`, `done`, `failed`, `killed` |
| `turns`, `maxTurns` | progress against the 10-turn budget |
| `lastTool`, `toolsUsed` | what it is doing right now |
| `startedAt`, `endedAt`, `outputChars` | cost and speed hints |
| `error` | why it failed or was killed |

Rules worth knowing:

- a finished agent can never go back to `running` because of a late event;
- a listener that throws cannot stop a subagent;
- `killAll()` runs on session shutdown so nothing is left hanging;
- `formatAgentSummary` produces one line, `formatAgentRoster` produces the list
  the Hub screen will draw.

The tool reports each turn through `onEvent`, and always leaves a final state,
even when the runner throws.

## Part B — typed results (`src/agent-schema.ts`)

Call the tool with `output_schema` (JSON Schema) and the answer comes back as a
value, not prose:

```json
{
  "description": "audit deps",
  "prompt": "List the risky dependencies",
  "output_schema": {
    "type": "object",
    "required": ["risks"],
    "properties": {
      "risks": {
        "type": "array",
        "items": {
          "type": "object",
          "required": ["name", "severity"],
          "properties": { "severity": { "enum": ["low", "high"] } }
        }
      }
    }
  }
}
```

The parent receives:

- `details.structured` — the parsed value, or `null`;
- `details.schemaMismatched` — true when the answer did not match;
- a `Schema: satisfied` (or `NOT satisfied`) line in the text, so a human sees
  the same truth as a script.

How it behaves:

1. the instruction is added to the subagent's prompt, including the exact schema;
2. on return, the JSON is extracted (fenced block, bare value, or JSON inside
   prose) and validated;
3. one repair turn is allowed — the subagent is told exactly which path is wrong
   and asked for the corrected JSON;
4. if it still does not match, the result is reported as **not** satisfied. A
   mismatch is never silently accepted.

The validator covers the shapes that matter for reports: object, array, string,
number, integer, boolean, null, union types, `enum`, `required`,
`additionalProperties`, `minItems`/`maxItems`, `minLength`, `pattern`, `minimum`
/`maximum`, and nested items. Issues are capped at 8 so a broken answer cannot
flood the context.

Fan-out (`tasks`) accepts a schema per task and returns `details.structured` as
an array in task order, with `null` where a task did not match.

## Part C — the screen (`src/agent-hub.ts`, `src/agent-hub-view.ts`)

A floating panel in the middle of the screen. Open it with **Alt+A** or
`/agents`. It draws the registry and nothing else:

```
╭──────────────────────────────────────────────────────────────────╮
│Subagents — 3 running                                             │
│   ✻ 1  map auth flow                        Explore · 4/10 · 12s │
│      running read                                                │
│ ▸ ✻ 2  audit deps                           General · 2/10 · 38s │
│      running bash                                                │
│   ? 3  plan the migration                      Plan · 0/10 · 2m5s │
│      needs approval — answer in the chat                         │
│   ✓ 4  find test files                      Explore · 3/10 · 21s │
│      done                                                        │
│                                                                  │
│↑↓ move · Enter open · s steer · k kill · r revive · Esc close     │
╰──────────────────────────────────────────────────────────────────╯
```

| Key | What it does |
|---|---|
| `↑` `↓` | move the selection (stops at the ends) |
| `Enter` | open this agent's transcript, `Esc` goes back |
| `s` | type a message for the selected agent, `Enter` sends it |
| `k` | stop the selected agent |
| `r` | run the selected agent again with the same task |
| `Esc` | close the panel |

Three rules, each one a decision:

1. **Approvals stay in the main chat.** A row only says
   `needs approval — answer in the chat`. If the panel were the only place to
   answer, an agent would wait forever whenever nobody opened it. The panel
   mirrors; the chat decides.
2. **Closing loses nothing.** Kill, steer and revive are registry calls, so they
   work whether the panel is open or not, and closing it never cancels work.
3. **Your message is delivered between turns.** A model request already in
   flight cannot be edited, so `steer` queues the text; the runner drains the
   queue at the next turn boundary and appends it as a user message. The queued
   text is shown in the transcript, so a steer is never invisible.

The view (`agent-hub-view.ts`) is pure text: no theme, no terminal, no timers.
Every line is clipped to the panel width, so a long description or a long hint
can never break the border. The panel (`agent-hub.ts`) only adds colours, keys
and the box — which is why the interesting cases are unit tested as strings.

Widths: the panel asks for 68 columns and shrinks to the terminal. Tested at 24,
40, 68 and 120 columns, and with a theme that throws, to prove a missing colour
token cannot blank the screen.

## Environment

| Variable | Effect |
|---|---|
| `QRONOS_HASHLINE=0` | disables `apply_patch` and numbered reads |
| `QRONOS_LSP_PATH` | narrows where language servers are looked for (used by tests) |

Agents are not restricted by an env var on purpose: a caller asks for a schema
per call, and a call without one behaves exactly as before.

## Tests

- `test/agent-registry.test.ts` — 19 tests: states, late events, kill-all,
  listeners, summary and roster text.
- `test/agent-schema.test.ts` — 19 tests: each schema keyword, JSON extraction
  from fences and prose, prompt and repair text.
- `test/agent-tool.test.ts` — adds 4 wiring tests (registry), 7 typed-result
  tests (schema reaching the runner, satisfied, repaired, mismatched, fan-out,
  `checkAgainstSchema`) and 3 schema-type tests (a JSON *string* schema is
  parsed and still enforced; a broken schema fails the call instead of turning
  validation off).
- `test/agent-hub.test.ts` — 24 tests: rows, icons, elapsed time, the
  "needs approval" wording, error lines, empty state, width clipping, selection
  clamping, word wrap, the summary line, and every key (`Esc` twice from the
  transcript, arrows, `k`, `s` + send, refusal to steer a finished agent, `r`,
  `dispose`).

## A bug this work found

A model sometimes sends `output_schema` as a JSON **string**. The first validator
ignored anything that was not an object, so validation silently switched off and
an impossible schema (`minimum: 10, maximum: 5`) was reported as satisfied.
`normalizeSchemaInput()` now parses a string, and refuses anything that is not a
schema: the call fails with `reason: "bad-schema"` before any subagent runs.
