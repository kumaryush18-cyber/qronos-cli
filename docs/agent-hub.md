# Agent Hub

Subagents already existed: `agent` runs a task in an isolated context, starts
read-only and needs `exit_plan_mode` approval before it may write. What was
missing was being able to *see* them (part A) and to *trust* what they return
(part B). Part C turns the registry into a screen; it is not built yet.

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

## Part C — the screen (not built)

`formatAgentRoster` is ready. Part C adds a small overlay: roster rows, `Enter`
for the transcript, `s` to steer, `k` to kill, `r` to revive. The registry
already carries everything the screen needs, so C is a renderer plus key
handling, not new state.

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
- `test/agent-tool.test.ts` — adds 4 wiring tests (registry) and 7 typed-result
  tests (schema reaching the runner, satisfied, repaired, mismatched, fan-out,
  `checkAgainstSchema`).
