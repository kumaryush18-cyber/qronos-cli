# Qronos CLI ⚡

An autonomous, terminal-first AI coding agent. It reads your codebase, edits files,
runs your shell and handles git — from a TUI that stays out of the way.

```bash
npx qronos-cli
```

---

## Quickstart

Run it without installing anything:

```bash
npx qronos-cli
```

Or install globally and use the shorter `qronos` alias:

```bash
npm install -g qronos-cli
qronos
```

On first run you get **two choices**:

1. **Sign in to the Qronos Gateway** — a browser login, no key to paste. Inference is
   developer-sponsored, so there is no bill.
2. **Use my own API key** — point it at any OpenAI-compatible or Anthropic-compatible
   endpoint: OpenAI, Anthropic, DeepSeek, Groq, OpenRouter, Ollama, or your own server.

A failed gateway sign-in returns you to the menu instead of exiting, so a backend outage
can never leave you stuck.

---

## Bring your own key

```bash
qronos --provider openai --api-key "$OPENAI_API_KEY"
qronos --base-url http://localhost:11434/v1 --model llama3    # any OpenAI-wire endpoint
```

Or answer "use my own API key" at the setup screen and it will ask for the endpoint, a
provider label, and a masked key, then fetch the model list from the server.

Your settings are saved to `~/.qronos/connections.json` (mode `0600`). **The key itself is
not saved by default** — it stays in memory and is read from the environment next time.
Storing it inline is an explicit opt-in.

---

## What it can do

- **Tools** — `read`, `write`, `edit`, `bash`, plus `web_search`, `docs_lookup` and
  `generate_image`.
- **Plan mode** — the agent investigates and writes a plan to `.qronos/plans/` instead of
  touching files. You approve, keep, or reject it. In plan mode `bash` is refused for
  anything that writes.
- **Permission modes** — auto, edit-automatically, manual, plan, and a deliberately
  dangerous skip-all. Switch with `/permissions` or the footer shortcut; the choice persists
  in `~/.qronos/config.json`.
- **Subagents** — delegate a focused job to a child agent. It inherits your tools and can
  never be more permissive than you: ask for a subagent in plan mode and it is read-only.
  Runs fan out in parallel, up to a depth and concurrency cap.
- **Layered memory** — `QRONOS.md` files are loaded from `~/.qronos`, the project root, and
  the current directory, so global preferences and per-repo rules both apply. `@import`
  pulls in more files; cycles are cut.
- **Learned memory (on by default)** — Qronos remembers what it works out in a project.
  Every turn is journaled locally, `/memory sync` folds the useful parts into a small
  document (decisions, constraints, workflows, failures, preferences) with one cheap model
  call, and the next session gets it as capped hints with the source files. The model can
  also save a lesson with the `learn` tool. Everything is local, redacted for secrets, and
  never duplicated across projects. See [docs/memory.md](docs/memory.md).
- **Compaction you can trust** — when a long session must be summarised, the input is pruned
  first, exact file paths, commands and error lines are recorded by code instead of being
  paraphrased, secrets are redacted, and a bad summary is refused so the built-in one runs
  instead. A checkpoint costs no extra model call. See [docs/compaction.md](docs/compaction.md).
- **Workflows (say `ultracode`)** — type the word and the model writes a small JavaScript
  script that fans work out to subagents; only the final value comes back to the chat, so
  a big audit does not flood the conversation. `agent`, `parallel`, `pipeline`, `phase` and
  `log` are the whole API; the script has no filesystem, no network and no `process`, and a
  run is capped at 10 minutes and 1000 agents (16 at once). `/workflows` shows the last run: every agent
  sorted by cost, a bright green tick or a dark red cross, tokens per agent and per phase,
  and a live line while it runs.
  It runs in the background, writes a redacted journal of every agent, and delivers its
  report on a later turn; `/workflows` lists what is running, and a run can be paused,
  resumed, stopped or replayed from its journal. A run of three or more written agent calls asks
  first: a card shows the phases, the cost, and `1. Yes` / `2. View raw script` / `3. No`, with
  `ctrl+g` to edit the script in `$EDITOR`. `Alt+W` (or `/workflows panel`) opens a live
  panel in two columns: the phases on the left, the agents of the phase you point at on the
  right, with the model, tokens and time of each one, the 3 s shimmer on whatever is working
  now, and `p` to pause, `x` to stop, `s` to save the script into `.qronos/workflows/`.
  See [docs/workflows.md](docs/workflows.md).
- **Lifecycle hooks** — run your own commands on `PreToolUse`, `PostToolUse`, `SessionStart`,
  `UserPromptSubmit` and `Stop`. Exit code 2 blocks the action.
- **MCP** — connect Model Context Protocol servers for extra tools: `qronos mcp --help`.
- **Sessions** — resume any past session with `qronos --session <id>`, or `-c` for the last one.

---

## Commands

| Command | What it does |
| :--- | :--- |
| `/model` | switch the active model |
| `/permissions` | change the permission mode |
| `/context` | inspect what is filling the context window |
| `/compact [focus]` | compress the conversation, optionally with a focus |
| `/recall [n]` | bring back an earlier prompt |
| `/review` | review the current diff |
| `/status`, `/doctor` | session and environment diagnostics |
| `/usage` | credits left today |
| `/memory` | what this project has learned (`view`, `stats`, `sync`, `add`, `forget`, `clear`) |
| `/workflows` | live workflows: phases, agents, tokens; `<id>`, `pause`, `resume`, `stop`, `save`, `saved`, `panel` |
| `/bug` | report a problem |
| `/update` | update the CLI |
| `Esc` | interrupt the running turn (only that) |
| `Ctrl+O` | expand tool output |

`/help` lists everything.

---

## Environment variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `QRONOS_API_KEY` | API key, skipping the sign-in prompt | — |
| `QRONOS_BASE_URL` | override the backend endpoint | `https://api.qronos.me` |
| `QRONOS_NO_INTRO` | `1` skips the first-run intro banner | — |
| `QRONOS_NO_AUTO_UPDATE` | `1` skips the self-update check | — |
| `QRONOS_NO_GRAVITY_PIXEL` | `1` disables the analytics pixel | — |
| `QRONOS_MODEL` | fallback model id when the server sends no catalog | — |
| `QRONOS_TUI_MODE` | `regular` = inline mode with terminal scrollback; `fullscreen` (default) lets a click in the input box place the cursor | `fullscreen` |
| `QRONOS_TITLE` | text for the terminal tab title; text only, no colour | `Qronos CLI` |
| `QRONOS_MAX_SUBAGENT_DEPTH` | how deep subagents may nest | `3` |
| `QRONOS_MAX_CONCURRENT_SUBAGENTS` | parallel subagents | `8` |
| `QRONOS_MEMORY` | `0` turns learned memory off | on |
| `QRONOS_MEMORY_AUTO` | `0` keeps memory but never syncs in the background | on |
| `QRONOS_MEMORY_BUDGET` | approximate tokens of memory injected per prompt | `1200` |
| `QRONOS_COMPACT` | `0` uses the built-in compaction summary | on |
| `QRONOS_COMPACT_MODEL` | cheaper model for the compaction checkpoint | session model |
| `QRONOS_WORKFLOW_WALL_CLOCK_MS` | time limit for one workflow run | `600000` (10 min) |
| `QRONOS_WORKFLOW_MAX_AGENTS` | agents a single workflow may start | `60` |
| `QRONOS_WORKFLOW_CONCURRENCY` | workflow agents running at once | `8` |

---

## Privacy

Your source code is not sent anywhere except the model endpoint you chose. No file contents
are logged by us, and no API key you supply is transmitted to us or written to disk unless
you ask for it.

Two things do reach our server on the gateway path: the consent version, and — after you
accept the notice — a request that carries your account id so sponsored placements work.
`QRONOS_NO_GRAVITY_PIXEL=1` turns that off. Configured as BYOK, neither happens.

---

## License

MIT © 2026 Qronos AI. Built on open agent standards.
