# Qronos CLI ⚡

An autonomous, terminal-first AI coding agent powered by [Qronos AI](https://qronos.me). Features intelligent codebase navigation, in-terminal tool execution (`bash`, `read`, `write`, `edit`), git workflows, and developer-sponsored inference.

```bash
npx qronos-cli
```

---

## 🚀 Quickstart

Run directly without global installation:

```bash
npx qronos-cli
```

Or install globally:

```bash
npm install -g qronos-cli
qronos-cli
```

*(You can also use the shorthand alias `qronos`)*

---

## 🔑 Authentication

1. **Direct API Key:**
   Set your Qronos API key from your dashboard at [qronos.me/account](https://qronos.me/account):
   ```bash
   export QRONOS_API_KEY="sk_live_..."
   qronos-cli
   ```

2. **Interactive Sign-In:**
   Running `qronos-cli` without an environment variable guides you through sign-in and stores credentials securely under `~/.qronos/agent/credentials.json`.

---

## 🛠️ Features

- **Agentic Tool Loop:** Inspects files (`read`), creates files (`write`), applies surgical patches (`edit`), and runs commands in your terminal (`bash`).
- **MCP Support:** Connect any Model Context Protocol servers to provide custom tools to the agent (`qronos-cli mcp --help`).
- **Session Continuity:** Resume any past session effortlessly:
  ```bash
  qronos-cli --session <session-id>
  ```
- **Universal Gateway Integration:** All completions route through Qronos AI's high-speed, active safety shielded API (`https://api.qronos.me`).

---

## ⚙️ Environment Variables

| Variable | Description | Default |
| :--- | :--- | :--- |
| `QRONOS_BASE_URL` | Override the backend API endpoint | `https://api.qronos.me` |
| `QRONOS_API_KEY` | Direct API key bypassing interactive prompt | `""` |
| `FREEPI_NO_GRAVITY_PIXEL` | Set `1` to disable Gravity analytics pixel | `0` |

---

## 📜 License

MIT License © 2026 Qronos AI. Built on open agent standards.
