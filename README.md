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
| `/compact` | compress the conversation |
| `/recall [n]` | bring back an earlier prompt |
| `/review` | review the current diff |
| `/status`, `/doctor` | session and environment diagnostics |
| `/usage` | credits left today |
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
| `QRONOS_MAX_SUBAGENT_DEPTH` | how deep subagents may nest | `3` |
| `QRONOS_MAX_CONCURRENT_SUBAGENTS` | parallel subagents | `8` |

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
