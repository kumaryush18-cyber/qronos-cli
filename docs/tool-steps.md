# Step names above shell commands

Claude Code prints two lines for a shell call:

```
● Sweeping route list with anthropic headers
  ⎿ $ cd /workspaces/.later && cat > sweep.py <<'EOF'
```

The first line is **not** prose the model wrote around the call. It is a field
inside the call. Anthropic's own tool schema says so:

```ts
export interface BashInput {
  command: string;
  timeout?: number;
  /** Clear, concise description of what this command does in active voice. */
  description?: string;
}
```

That schema also teaches the wording — *"5-10 words"*, four worked examples,
and *never* the words "complex" or "risk".

## What we do

pi's bash tool has only `command` and `timeout`, so the model has nowhere to put
a step name and the screen has nothing to print. We fix that without forking pi:

1. `src/tool-aliases.ts` re-registers `bash` and `powershell` with pi's own
   definition (`createBashToolDefinition`, `createPowerShellToolDefinition`) and
   **one extra optional field**: `description`. Execution is unchanged — pi's
   bash still runs the command; it ignores the extra key.
2. The same field's own description carries Claude Code's examples, and a
   guideline bullet points at it, so the model knows when to fill it.
3. `src/tool-step.ts` cleans and cuts the sentence. It is the only place that
   touches the model's words.
4. `src/tool-renderer-claude.ts` draws the sentence on top and the command
   underneath, with `$` for bash and `PS>` for powershell.

Nothing else moves. The tool is still called `bash`, so approvals, the workflow
tool door, plan mode and `readToolFacts` keep working without a change.

## Rules this feature must keep

- **Optional, always.** A resumed session, an old transcript, an MCP tool and a
  workflow agent can all send no `description`. The display then falls back to
  the plain `● Bash(cmd)` line. A missing field is never an error.
- **One line, capped.** ANSI colours, OSC links, control characters, newlines
  and runs of spaces are stripped, and the result is cut at 90 characters. The
  command preview is cut at 120. A model cannot paint the transcript.
- **A repeat is dropped.** If the description is just the command again, we
  draw nothing — saying the command twice is noise.
- **`QRONOS_TOOL_DESCRIPTIONS=0` turns it off in both places.** The schema stops
  offering the field *and* the renderer stops drawing it, so no tokens are spent
  asking for a sentence nobody shows. Schema and renderer read the same
  function on purpose: they must agree.
- **Never invented.** When the model sends no description we print the command,
  not a guessed summary.

## Cost

One short field per shell call (about 10 tokens out) and three lines of system
prompt. Off switch above if you want them back.

## Tests

- `test/tool-step.test.ts` — cleaning, cutting, ANSI, repeats, missing fields.
- `test/tool-renderer-step.test.ts` — the two drawn lines, the fallback, the
  off switch, the width at 40/60/74/120 columns.
- `test/tool-aliases.test.ts` — the schema really offers the field, it is
  optional, and the guideline is added without dropping pi's own.
- `scripts/tool-step-e2e.ts` — a real model on a neutral prompt: does it fill
  the field by itself, and do the two lines fit the width?
