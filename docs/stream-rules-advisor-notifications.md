# Stream rules, advisor and notifications

Three features ported from [oh-my-pi](https://github.com/can1357/oh-my-pi) in November 2026. All three are off until you ask for them.

## Stream rules (stop a turn mid-sentence)

Rules are regexes. While the model streams its answer, Qronos CLI checks the text. When a rule matches, the stream is stopped right there, and the rule's message is added to the next request. The model then rewrites the bad line.

Put rules in one of two files:

- `.qronos/stream-rules.json` — project rules, safe to commit
- `~/.qronos/stream-rules.json` — your own rules

```json
[
  {
    "name": "no-eval",
    "pattern": "\\beval\\s*\\(",
    "message": "Never call eval(). Use JSON.parse or a real parser."
  },
  {
    "name": "no-inner-html",
    "pattern": "dangerouslySetInnerHTML",
    "message": "Sanitize with DOMPurify instead of dangerouslySetInnerHTML."
  }
]
```

Optional keys: `flags` (default `i`), `disabled` (`true` to skip), `name` (used in the status line and for de-duplication).

Why it is cheap: the rule is sent to the model **once**, at the moment it broke it, instead of on every request.

A rule fires at most once per turn, so a repeating pattern cannot loop the model. If the file is broken, the CLI prints a warning and runs normally.

## Advisor (a second pair of eyes)

A cheap model reads each finished turn and writes short notes. It cannot edit files and cannot approve anything.

```bash
QRONOS_ADVISOR=1 qronos-cli                 # review with the session model, every turn
QRONOS_ADVISOR=deepseek-v4-flash qronos-cli  # review with a cheaper model
QRONOS_ADVISOR=1 QRONOS_ADVISOR_EVERY=3 qronos-cli
```

Notes appear in the footer. They are injected into the next request as a short `<advisor-notes>` section, then dropped — the reviewer never becomes part of the permanent prompt.

Cost control: one review at a time, 45-second timeout, at most 4 notes (set `QRONOS_ADVISOR_MAX_NOTES`). A failed review is silent.

## Desktop notifications

When a turn takes longer than 5 seconds and finishes, the terminal gets one notification. Useful when you switch windows during a long run.

Supported terminals: iTerm2, WezTerm, Ghostty, Windows Terminal, Hyper, Konsole (rxvt-style protocol). Others stay silent on purpose — a wrong escape sequence can corrupt the screen.

```bash
QRONOS_NOTIFY=0 qronos-cli   # off
QRONOS_NOTIFY=1 qronos-cli   # force OSC 9, even on an unknown terminal
```

## Frame rate

Redraws run at about 60 fps by default. On battery, over SSH, or in a slow terminal you can cap them:

```bash
QRONOS_FPS=30 qronos-cli
```

Nothing changes when the variable is unset. Values are clamped to 5–60.

## Shell completions

```bash
# bash
qronos-cli completions bash > ~/.bash_completion.d/qronos-cli
# zsh
qronos-cli completions zsh > "${fpath[1]}/_qronos-cli"
# fish
qronos-cli completions fish > ~/.config/fish/completions/qronos-cli.fish
```

The scripts are generated from one flag list in `src/completions.ts`, and the test suite runs `bash -n` and `zsh -n` on them, so a quoting mistake fails CI instead of your login shell.

Inside the TUI, `/` lists slash commands and `@` completes file paths (existing behaviour, unchanged).
