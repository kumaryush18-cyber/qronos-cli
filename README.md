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
- **Step names above shell commands** — every `bash` call carries an optional short
  sentence the model writes itself: `List files in current directory`, `Show working tree
  status`. The transcript draws it above the command, Claude Code style, and falls back to
  the plain one-line form when the model sends none. `QRONOS_TOOL_DESCRIPTIONS=0` removes
  the field entirely. See [docs/tool-steps.md](docs/tool-steps.md).
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
  now, and `p` to pause, `x` to stop, `s` to save the script into `.qronos/workflows/`,
  `r` on one agent to run that agent again (it asks first, because it spends tokens again).
  `enter` opens one agent: what it was asked, the last tool calls with their arguments
  (`read(path: package.json)`), how long it has been idle, and its answer or error.
  While a background run is live a second row sits above the editor —
  `※ Waiting for 1 dynamic workflow to finish`, with the same 3 s orange shimmer — and a
  finished run ends with a table of the structured results when the agents used a `schema`.
  A subagent's tool call meets **your permission mode**: in `auto` a read, a write inside the
  project and a plain shell command go ahead, and a destructive command or a write outside the
  project stops at a card in the chat — `Yes`, `Yes, allow shell commands for this run`,
  `Yes, and switch to auto mode`, `No`. Closing the card means No, and a grant dies with the run.
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
| `/export` | export the conversation as plain text: copy it, or save a `.txt` file |
| `/export <file>` | write that file straight away, with no question |
| `/review` | review the current diff |
| `/status`, `/doctor` | session and environment diagnostics |
| `/usage` | credits left today |
| `/memory` | what this project has learned (`view`, `stats`, `sync`, `add`, `forget`, `clear`) |
| `/workflows` | live workflows: phases, agents, tokens; `<id>`, `pause`, `resume`, `stop`, `restart`, `save`, `saved`, `panel` |
| `/workflows scripts` | the scripts you saved in this project; `run <name>` runs one, `edit <name>` changes one |
| `r` in an agent | run that one agent again — same task, or one you edit first; it asks before it spends |
| `/bug` | report a problem |
| `/update` | update the CLI |
| `Esc` | interrupt the running turn (only that) |
| `Ctrl+O` | expand tool output |

`/help` lists everything.

---

## Free models

Four free models can appear in `/model` under **free**: `particle`,
`deepseek-v4.1-flash`, `glm-5.3-flash`, `deepseek-v4-flash`.

You do nothing special to get them. Sign in to Qronos once with the GitHub device
flow, and the CLI asks the Qronos gateway for the shared model pool with your own
Qronos key. There is no second sign-in, no key to paste, and nothing is written
to disk.

That pool is the **only** source, on purpose: one hidden second source would make
a broken pool look fine. If the gateway cannot be reached the pool is simply
empty. The CLI still starts, `/model` shows no free model, and one line says the
free models are unavailable right now.

One honest limit: the upstream free tier allows one live request per key, so a
pool of N keys serves N requests at the same moment. When all are busy, a request
waits, and says so if the wait runs out.

Which ad you see follows the model, never a fallback:

- a free model shows the free ad, and **never** a Qronos ad;
- a Qronos model, or a third-party BYOK model, shows the Qronos ad, and never a
  free one;
- the inline card obeys the same rule.

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
| `QRONOS_TOOL_DESCRIPTIONS` | `0` removes the step-name field from `bash`/`powershell` and the line from the transcript | on |
| `QRONOS_FREEPI_INVITE` | the sign-up link the owner sign-in shows, so it can change without a release | set in the owner's environment |
| `QRONOS_DEBUG_FREEPI` | `1` keeps the raw upstream error text beside the masked sentence | off |
| `QRONOS_DEBUG_ADS` | `1` prints one line per ad fetch: the slot, the status, and `no fill` when the answer was empty | off |
| `QRONOS_NO_AD_ATTRIBUTION` | `1` stops sending the hashed account email to the ad network | off |
| `QRONOS_FREEPI_TOKEN` | no longer a token source. The shared pool in the admin panel is the only one; it is never used for a request | — |
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
| `QRONOS_WORKFLOW_TOOLS` | `0` turns off the per-tool permission door for workflow subagents | on |

---

## Privacy

Your source code is not sent anywhere except the model endpoint you chose. No file contents
are logged by us, and no API key you supply is transmitted to us or written to disk unless
you ask for it.

Two things do reach our server on the gateway path: the consent version, and — after you
accept the notice — a request that carries your account id so sponsored placements work.
`QRONOS_NO_GRAVITY_PIXEL=1` turns that off. Configured as BYOK, neither happens.

Inside a sponsored request, and only when a real ad slot is being fetched:

- the **last few turns of the conversation** (at most 8, 4 000 characters each), with
  secret-looking strings redacted before they leave the machine. This is what makes the
  slot worth anything; an ad network prices real conversation, not a topic line.
- a **hashed** account email (SHA-256 of a trimmed, lowercased address). The address
  itself never exists on your machine and never leaves our server.
- the real operating system, CPU architecture and CLI version, so the request is not
  pretending to be a different machine.

`QRONOS_NO_AD_ATTRIBUTION=1` drops the hashed email only; `QRONOS_NO_GRAVITY_PIXEL=1`
drops the whole ad identity. Ads are requested only in an interactive terminal, never
from a piped or CI run.

---

## License

MIT © 2026 Qronos AI. Built on open agent standards.
