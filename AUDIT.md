# Qronos CLI — full source audit & "Claude Code style" conversion plan

Repo: `kumaryush18-cyber/qronos-cli` (private) · commit `f8af34c` · audited read-only except §7.
Method: every file under `src/` read, every test file scanned, `tsc --noEmit` + `bun test` run,
and each claim below traced to a file:line.

> **Read this first — mirror caveat.** `AGENTS.md` states this repo is a *one-way generated
> mirror* of a private monorepo (`packages/cli` + vendored `pi-ads` / `shared`), and that edits to
> `src/`, `test/`, `README.md`, `CHANGELOG.md`, `package.json` are overwritten on the next sync.
> Everything in §5–§8 is therefore written as a **spec for the monorepo**, and the logo change in
> §7 is a prototype that must be ported upstream or it will be lost.

---

## 1. Health baseline

| Check | Result |
|---|---|
| `tsc --noEmit` | **clean, exit 0** |
| `bun test` | **878 pass / 0 fail** (878 tests, 69 files) — was 869/7 before this pass |
| Source size | 93 files, 12,545 LOC (`src/*.ts` 9,705 + `vendor` 2,840) |
| Tests | 62 test files (~0.66 test files per source file) |
| Runtime deps | 3 (`pi-coding-agent@1.2.0`, `pi-tui@1.2.0`, `@gravity-ai/api@1.2.1`) — pinned exact, good |
| Node floor | `>=22.19.0` |

The 7 failures that opened this audit were **not** new logic bugs: the freepi→qronos refactor moved the ad
frame from `┌┐└┘` to rounded `╭╮╰╯` and left `freepi.ai` in the fixtures. They are now fixed (see §9),
along with three real bugs the green-up pass uncovered.

---

## 2. Architecture (one page)

```
bin → src/index.ts (side-effect entry)
        └─ main.ts         local command dispatch: version | help | logout | mcp | init
             ├─ cli-args.ts        pure argv → ParsedArgs (no I/O, no TTY)
             ├─ first-run.ts       consent → auth-flow (device flow) → credentials
             ├─ self-update.ts     npm -g reinstall, gate-checked, never sudo
             └─ run.ts             session loop / resume / relaunch
                  └─ pi-launch.ts  541 LOC: builds the pi session, registers
                       ├─ provider.ts + model-fetch.ts + fusion.ts   model catalog
                       ├─ theme-claude.ts + tool-renderer-claude.ts  Claude visuals
                       ├─ header.ts + footer-align.ts + resume-line.ts
                       ├─ commands.ts  slash commands (/init /memory /hooks /cost …)
                       ├─ agent-tool.ts(s) + agent-discovery.ts + agent-scan.ts  subagents
                       ├─ plan-mode.ts + exit-plan-tool.ts + todo-tool.ts       plan/todo
                       ├─ hooks.ts + hooks-runner.ts + hooks-extension.ts       lifecycle hooks
                       ├─ tool-guard.ts + tool-aliases.ts + execution-modes.ts
                       └─ vendor/pi-ads/*   terminal ad rendering (sponsor revenue)
```

**Real strengths.** Pure `cli-args.ts` (no process/TTY reads) makes arg parsing fully testable;
deps are injected everywhere it matters (`LogoutDeps`, `McpCommandDeps`, `RealSpawnIO`,
`spawnImpl`), so no test touches `$HOME` or the network; every network call carries an
`AbortSignal` timeout; widths are clamped before slicing; `update-check`/`whats-new`/`self-update`
are all fail-soft by construction (a broken state file can never block launch). Comment density is
unusually high and explains *why*, not *what* — keep that.

---

## 3. Per-file inventory

Legend: **P0** blocks release · **P1** should fix soon · **P2** polish · **P3** nitpick.

### 3.1 Entry, args, process lifecycle

| File | LOC | Role | Findings |
|---|---|---|---|
| `index.ts` | 26 | Side-effect entry, runs `main()` on import | P3 — untestable by design; `real-spawn.ts` already exists as the seam, keep going that way |
| `main.ts` | 152 | Dispatch local commands before launching pi | P2 — dispatch is an if/else chain; a `Map<string, handler>` would let `mcp`/`init` register themselves and removes 3 branches |
| `cli-args.ts` | 122 | Pure argv parse + `HELP_TEXT` | P2 — `HELP_TEXT` is a hand-aligned string; it silently drifts from the real flags. Generate it from a `FLAGS` table and snapshot-test it |
| `cli-config.ts` | 88 | Env/config precedence | P2 — precedence rules are documented only in comments; add a table test |
| `env.ts` | 5 | Env read helper | P3 — fine |
| `version.ts` | 6 | `CLI_VERSION` | P3 — correct: it imports `package.json` (bun inlines it at build time), so there is no duplicate literal. The header used to hardcode `v1.0.0` instead of using it — fixed in §7 |
| `node-check.ts` | 36 | Node floor check | P3 — good; make the message include the exact running version |
| `real-spawn.ts` | 34 | spawnSync seam for self-update | P3 — `shell: true` on win32 is correctly justified in comments |
| `relaunch.ts` | 106 | Re-exec after self-update | P2 — assert `argv[1]` exists before re-exec |
| `self-update.ts` | 66 | `npm i -g qronos-cli@latest` | P2 — three gates are good; add "install dir not writable" (EACCES) as an explicit silent-skip branch rather than a generic catch |
| `update-check.ts` | 77 | Latest-version probe | P3 — good; it should be skipped when `CI=1` (slow + noisy in CI) |
| `interrupt-handler.ts` | 94 | Ctrl-C semantics | P2 — verify double-Ctrl-C force-exit path is covered by a test |
| `project-trust.ts` | 69 | Per-project trust prompt | P1 — trust is stored per directory string; resolve symlinks/`realpath` first or `cd`-aliases re-prompt |

### 3.2 Onboarding, auth, consent

| File | LOC | Role | Findings |
|---|---|---|---|
| `first-run.ts` | 298 | 2-choice onboarding (gateway sign-in / BYOK) | P2 — the longest non-UI file; split the two branches into `first-run-gateway.ts` / `first-run-byok.ts` |
| `consent.ts` | 42 | Privacy notice text | P2 — `REPROMPT_CONSENT_TEXT` is built by *string replacement* on `CONSENT_TEXT`; a wording edit upstream silently no-ops. Use a template param |
| `onboarding.ts` | 29 | First-run intro | P3 — `env[INTRO_ENV_SKIP] \|\| env.QRONOS_NO_INTRO]` reads the **same key twice** (the const *is* `"QRONOS_NO_INTRO"`) — dead branch |
| `auth-flow.ts` | 144 | GitHub device flow | P1 — timeout/AbortSignal good, but the polling interval is not jittered and `slow_down` handling should be asserted by a test |
| `browser.ts` | 96 | Open verification URL | P3 — genuinely well done (WHATWG normalization + cmd metachar escaping + `start ""`); nothing to change |
| `credentials.ts` | 30 | JWT file read/write | **P1 — writes with default mode**; `chmod 0600` the credentials dir/file explicitly, and refuse to read a token from a world-readable file |
| `logout.ts` | 29 | Delete local JWT | **P1 — security**: there is no server revoke, so a leaked 90-day JWT stays valid after logout. Either add a `/auth/revoke` endpoint or shorten JWT TTL + refresh |
| `connection-store.ts` | 161 | Persisted connection/provider state | P2 — version the on-disk schema (`{v:1,...}`) and migrate instead of failing soft |

### 3.3 Launch & session

| File | LOC | Role | Findings |
|---|---|---|---|
| `run.ts` | 312 | Resume/relaunch loop | P2 — resume id validation; reject path-traversal-looking session ids |
| `pi-launch.ts` | 541 | Builds the pi session, registers ~20 extensions | **P1 — god module**. Split: `launch/session.ts`, `launch/extensions.ts`, `launch/models.ts`, `launch/prompt.ts`. It is the single hardest file to review and the one every feature touches |
| `provider.ts` | 137 | Provider presets + `DEFAULT_MODEL` | P2 — 5 presets are inline objects; move to `providers.json` so BYOK additions need no code change. Also `DEFAULT_MODEL = "claude-sonnet-5.5"` is a **hardcoded model id that will rot** — derive from server catalog with a fallback |
| `provider-lock.ts` | 45 | Scope picker to qronos models | P3 — clean, well documented |
| `model-fetch.ts` | 190 | Server model catalog | P2 — cache to disk with a TTL so offline start does not block on the network |
| `fusion.ts` | 125 | Planner/executor virtual model | **P2 — `ctx.modelRegistry.find(PROVIDER_NAME, defaultModelId)!`** (line 119) is a non-null assertion on a registry lookup; if the catalog lacks the row, Fusion throws at pick time. Return a routable fallback or a clear error |
| `prompt.ts` | 51 | System prompt assembly | P2 — see §6: needs a Claude-Code-grade environment block |
| `memory.ts` | 191 | Layered `QRONOS.md` (user / root / dir) | P3 — good design (mirrors CLAUDE.md precedence, zero tokens when absent) |
| `memory-io.ts` | 53 | Memory file IO | P3 — fine |
| `paths.ts` | 50 | `~/.qronos/...` resolution | P2 — honour `QRONOS_CONFIG_DIR` and add Windows `%APPDATA%` fallback |
| `agent-rules.ts` | 21 | AGENTS.md/CLAUDE.md discovery | P3 — `CLAUDE.md` is a symlink to `AGENTS.md` in this repo; make the loader read both without double-counting |

### 3.4 Slash commands & TUI surfaces

| File | LOC | Role | Findings |
|---|---|---|---|
| `commands.ts` | 575 | 11 slash commands | **P1 — god module + blocking git calls.** Lines 429/430/465/467 call `execSync("git …")` **without a `timeout`** on the UI thread: a slow/huge repo freezes the whole TUI. Use `execFile` with a 2 s timeout and render lazily. Also split one file per command (`commands/init.ts`, `commands/memory.ts`, …) |
| `init-cmd.ts` | 123 | `/init` → generate `QRONOS.md` | **P1 — `await runInit(fakeCtx as any)`** (line 121) plus a hand-built fake `ctx`. Make `runInit` accept a small `InitDeps` interface (confirm / notify / cwd) like `logout.ts` does. Also: `JSON.parse` result is untyped `any`, `runInitCli` returns 0 even when the write failed, Python branch sets only `ruff` with no build | 
| `commands.ts` `/cost`, `cost-cmd.ts` | 91 | Token/cost report | P2 — verify pricing table versioning; unknown models should report "unknown", not 0 |
| `whats-new.ts` | 43 | Once-per-upgrade changelog | P3 — good; make the marker write atomic (write temp + rename) |
| `changelog.ts` | 217 | Parses `CHANGELOG.md` | P2 — parsing its own shipped changelog is brittle; ship `highlights.json` at build time. Also **all 217 lines still reference freepi** |
| `context-view.ts` | 104 | `/context` | P3 — fine |
| `cost-cmd.ts` | 91 | `/cost` impl | P2 — see above |
| `todo-tool.ts` / `todo-view.ts` | 239 / 93 | Claude-style todo list | P3 — already Claude-parity; the render is the best-behaved widget in the repo |
| `plan-mode.ts` / `exit-plan-tool.ts` / `plan-io.ts` | 101 / 114 / 100 | Plan mode + ExitPlanMode | **P2 — no `EnterPlanMode` tool**, so the agent cannot *choose* to plan; Claude Code exposes both directions. See §6 |
| `effort-selector.ts` | 259 | Thinking-level picker | P2 — 259 LOC for a picker; extract the key handling into a shared `select-list.ts` with `file-completion.ts`'s list |
| `tools` note | — | `tool-aliases.ts` 80 | P2 — alias table duplicates names in `agent-tools.ts`; single source |
| `theme-claude.ts` | 93 | Claude dark theme | P3 — already correct; document the palette tokens so a rebrand is one file |
| `tool-renderer-claude.ts` | 488 | Claude-style tool blocks + truecolor diffs | **P2 — 488 LOC, no visual regression tests.** Add golden-output tests for `edit`/`write`/`bash` blocks (string snapshots) before touching it |
| `header.ts` | 173 | Logo + status header | See §7 — logo geometry was wrong (rectangular); fixed |
| `footer-align.ts` | 159 | Footer layout | P2 — contains a `execSync(..., timeout: 2000)` story in comments; confirm no live sync call remains |
| `resume-line.ts` | 72 | "resume with --session" hint | P3 — fine |
| `error-notice.ts` | 130 | Error banner | P2 — still asserts freepi strings in tests |
| `interrupt-handler.ts` | 94 | see 3.1 | |

### 3.5 Subagents, tools, safety

| File | LOC | Role | Findings |
|---|---|---|---|
| `agent-tool.ts` | 531 | Agent/Task tool | **P1 — 531 LOC single file.** Split into `agent/tool.ts`, `agent/prompt.ts`, `agent/filter.ts`. Non-null assertions at `pi-launch.ts` (3) and the tool-filter logic deserve dedicated tests |
| `agent-tools.ts` | 178 | Tool allow/deny filtering | P2 — deny-list by substring match on tool names is fragile; match exact ids |
| `agent-discovery.ts` | 213 | Discovers `agents/*.md` | P2 — path traversal check on agent names; validate `^[a-z0-9-]+$` |
| `agent-scan.ts` | 101 | Non-interactive classifier over transcripts | P2 — this is the one place a model call is *not* abortable by the user; give it a hard timeout |
| `tool-guard.ts` | 91 | Blocks dangerous tool input | **P1 — this is the security boundary.** No tests for `bash` payloads that are `base64 | sh`, `$IFS` tricks, or `git config core.pager`. Add a hostile-input fixture set; treat "guard" as allow-list, not deny-list |
| `execution-modes.ts` | 332 | auto / ask / plan / yolo | **P1 — 332 LOC of policy, and `yolo` must be opt-in per invocation, never sticky in config.** Verify it is not persisted |
| `web-tools.ts` | 111 | Web fetch/search | **P1 — `SSRF`**: outbound fetch of model-chosen URLs must reject `169.254.169.254`, `localhost`, `10/8`, `172.16/12`, `192.168/16`, `::1` and non-http schemes, and must re-check after each redirect. Also cap response size before buffering |
| `image-tool.ts` | 159 | Image read | P2 — enforce a max file size + mime sniff before base64 |
| `docs-tool.ts` / `docs.ts` | 34 / 73 | Docs lookup tool | P2 — `docs.ts` holds docs text inline; ship as `.md` and import |
| `hooks.ts` / `hooks-runner.ts` / `hooks-extension.ts` | 178 / 144 / 139 | Lifecycle hooks | **P1 — hooks execute user shell commands.** Require an explicit trust prompt per file, and pass args as an array (never interpolate into a shell string). Tests exist (`hooks.test.ts`) but not for injected `;` / `$( )` |
| `buy-tool.ts` | 103 | Credits purchase | P2 — open URL only after `safeBrowserUrl` (it does); ensure no token in the URL |
| `usage-tool.ts` | 112 | Free-allowance check | P3 — fine |
| `tool-renderer-claude.ts` | 488 | see 3.4 | |
| `file-completion.ts` + `-extension.ts` | 210 / 27 | `@`-file completion | P2 — must skip `node_modules`/`.git` and cap entries; add a symlink-loop guard |
| `mcp-command.ts` | 75 | `qronos-cli mcp …` | **P1 — imports pi's private `dist/extensions/mcp/cli.js`** via `import.meta.resolve`. A pi patch release breaks `mcp` outright (a test guards the path, but the guard only tells you *after* the upgrade). Ask pi for a public export, or vendor the command |
| `bug-report.ts` | 117 | Prefilled issue URL | P2 — scrub absolute paths, `$HOME` and env values before putting logs in a URL |
| `gravity-pixel.ts` | 97 | Ad impression metering | P2 — fire-and-forget is right; ensure it never delays exit |
| `cli-args.ts` | 122 | see 3.1 | |
| `whats-new.ts` | 43 | see 3.4 | |

### 3.6 Vendored ad stack (`src/vendor/pi-ads`, `src/vendor/shared`)

`banner.ts`, `inline.ts`, `render.ts`, `resize.ts`, `width.ts`, `gravity.ts`, `sandbox.ts`,
`meter.ts`, `api.ts`, `config.ts`, `credits.ts`, `lane.ts`, `errors.ts`.

- **was P0, now green.** Rounded corners `╭╮╰╯` vs expected `┌┐└┘` and `freepi.ai` fixtures are fixed
  in §9. Remaining work here is the two hardening items below (wide chars, sandbox negative test).
- **P1 — `width.ts` / `resize.ts`**: East-Asian wide chars and emoji ZWJ sequences are the classic
  source of ad-box misalignment. Add a fixture table (CJK, emoji, combining marks, RTL) and assert
  every rendered line is exactly `width` cells.
- **P1 — `sandbox.ts`**: this is the boundary that keeps ad content out of the model context.
  Give it a negative test: an ad payload containing `\x1b[2J`, OSC 8 hyperlinks, and 10 MB of text
  must be truncated/neutralized.
- **P2 — `meter.ts`/`gravity.ts`**: any network call must be abortable and must not run when
  `QRONOS_NO_ADS=1`; document that flag in README.
- `lane.ts` (shared): the "never a JS float" money handling is correct — keep it, and add a test for
  `0.1 + 0.2` style rounding at the boundary.

---

## 4. Ranked issue list (what I would actually fix, in order)

| # | Sev | Issue | Where | Fix size |
|---|---|---|---|---|
| 1 | ~~P0~~ done | 7 failing tests: rounded frame + `freepi.ai` fixtures | `src/vendor/pi-ads/*.test.ts` | S |
| 2 | ~~P0~~ mostly done | brand residue in tests + `createFreePiCommandsExtension`; **still open in `CHANGELOG.md` and `src/changelog.ts`** | `CHANGELOG.md`, `src/changelog.ts` | S–M |
| 2b | **P1** | **stale `ctx` crash (fixed, §9):** an ad write after a session reload threw into the agent loop | `src/vendor/pi-ads/{banner,inline,meter}.ts` | S |
| 3 | **P1** | credentials written world-readable; no server-side revoke | `credentials.ts`, `logout.ts` | S |
| 4 | **P1** | SSRF in `web-tools.ts` (model-chosen URLs) | `web-tools.ts` | M |
| 5 | **P1** | `execSync` git calls with no timeout on the UI thread | `commands.ts:429,430,465,467` | S |
| 6 | **P1** | hooks run shell strings built from user/config data | `hooks-runner.ts` | M |
| 7 | **P1** | `pi-launch.ts` (541) / `commands.ts` (575) / `agent-tool.ts` (531) god modules | 3 files | L |
| 8 | **P1** | `fakeCtx as any` and other `: any` (40 occurrences) | `init-cmd.ts`, `web-tools.ts`, `provider.ts` | M |
| 9 | **P1** | `mcp` depends on pi's private dist path | `mcp-command.ts` | S |
| 10 | **P2** | `DEFAULT_MODEL` hardcoded (will rot as the catalog moves); header hardcoded `v1.0.0` | `provider.ts`, `header.ts` | S |
| 11 | **P2** | no `EnterPlanMode`; plan mode is one-way | `plan-mode.ts` | M |
| 12 | **P2** | no golden-output tests for the tool renderer | `tool-renderer-claude.ts` | M |
| 13 | **P2** | model catalog has no disk cache (offline start blocks) | `model-fetch.ts` | S |
| 14 | **P3** | `onboarding.ts` dead env branch; `consent.ts` string-replace template | 2 files | XS |

Quick wins that make the repo instantly more "Claude Code": **#1, #2, #5, #10**.

---

## 5. "Claude Code style" — what is already there

Credit where due; these are already at parity and should not be rewritten:

- Plan mode + `ExitPlanMode` + todo list with the same visual grammar.
- Claude dark theme (`theme-claude.ts`) and Claude-style tool blocks with truecolor diffs.
- Subagent/Task tool with per-agent tool filtering and prompt files (`agents/*.md`).
- Layered memory (`QRONOS.md`: user → root → directory), mirroring CLAUDE.md precedence.
- `/init` generating project instructions; `/memory`, `/hooks`, `/cost`, `/context` slash commands.
- Permission modes (auto / ask / plan / yolo) with a tool guard.
- Fail-soft startup: update check, what's-new, self-update never block launch.

## 6. "Claude Code style" — the gaps that actually show

1. **No `/compact` and no auto-compaction policy.** Claude Code's headline behaviour is that a
   long session degrades gracefully. Add `/compact [hint]` plus an automatic trigger at a context
   threshold, preserving the todo list and the last N tool results verbatim.
2. **No `EnterPlanMode`.** Planning is entered by the human only. Claude Code lets the model propose
   a plan for non-trivial tasks; expose the tool and gate it behind the permission mode.
3. **No `AGENTS.md`-aware subagent brief.** Subagents get filtered tools but not the project memory
   layers, so they re-derive conventions. Pass the resolved `QRONOS.md` chain into the subagent prompt.
4. **No `/clear` vs `/new` distinction** and no session-title generation. Claude Code names sessions
   from the first user message; here sessions are only `--session <id>`.
5. **No per-tool permission prompt copy.** Ask-mode prompts should say *what* will run (`bash:
   rm -rf build`) up front, not just the tool name — that is the single biggest trust difference.
6. **No diff-review step after edits** (`/diff`). Claude Code shows accumulated changes for approval.
7. **Terminal-width discipline.** Only 5 places read `process.stdout.columns`; every widget should
   get width from one injected `Terminal` object so `resize` is testable (the ad stack already does
   this — copy the pattern).
8. **No `--output-format stream-json` / non-interactive `-p` mode.** Claude Code is scriptable
   (`claude -p "..."`). A headless JSON mode is the difference between a toy and a CI citizen.
9. **Help text drift** — `HELP_TEXT` is hand-written (§3.1). Claude Code's help is generated.
10. **No docs for the permission model** — the README should have a table of mode × tool × prompt.

---

## 7. Logo analysis and the square fix

### Why it looked rectangular

```
terminal cell ≈ 1 wide × 2 tall  →  visual width  = cols
                                    visual height = rows × 2
```

The mark in `src/header.ts` is **19 cols × 11 rows** with an ink box of **18 × 11**. In pixels that
is `18 × 22`, i.e. **0.82 of a square** — 18 % narrower than it is tall, which is exactly the
"rectangular" impression reported. For a square you need `cols = 2 × rows`: at 11 rows that is
22 columns.

### Status: reverted

Three variants were prototyped and rejected by the owner (`git checkout -- src/header.ts
test/header.test.ts`): a stretched 22 × 11 pixel Q, a 22 × 11 ring + Q tail, and a full-bleed
22 × 11 solid mark with a counter and a notch tail. The shipped art is unchanged.

**The geometry finding still stands** and is the useful part of this section: the current mark is
0.82 of a square and will read as a tall rectangle in any terminal. If it is ever revisited, the
rule to encode is `cols === 2 * rows` — with a one-line test, so no art change can silently
reintroduce the distortion.

### Other square options, if the ring is not the chosen mark

| Option | Geometry | Note |
|---|---|---|
| Ring + Q tail (chosen) | 22 × 11 | square, readable at 40 cols |
| Filled disc with a notch | 22 × 11 | heavier at small widths |
| Half-block "Q" using `▀▄█` | 16 × 8 | 2 cols per glyph → still square, denser look |
| Pure ASCII (CI-safe) | 20 × 10 | for terminals without Unicode block support; detect via `LANG`/`WT_SESSION` |

Rule to keep in `AGENTS.md`: **any logo/mark art must satisfy `cols === 2 * rows`.** A one-line
test is cheaper than a design review.

---

## 8. Suggested PR sequence

1. **`test: get to green`** — fix the 7 ad-stack tests (frame + fixtures), purge `freepi` from
   `test/`, rename `createFreePiCommandsExtension` → `createCommandsExtension`. No behaviour change.
2. **`fix(header): square logo mark`** — the §7 change, plus the geometry test.
3. **`fix(security): credentials 0600 + web-tools SSRF guard + hooks arg arrays`** — three focused
   commits, each with a hostile-input test.
4. **`perf(commands): execFile with timeout, off the UI thread`**.
5. **`refactor: split pi-launch / commands / agent-tool`** — mechanical, file moves only.
6. **`feat: /compact + EnterPlanMode + session titles`** — the Claude-parity features from §6.
7. **`feat: headless -p / stream-json`** — scriptability.

Steps 1–4 are safe in this mirror. Steps 5–7 belong in the monorepo (`packages/cli`), because a
mirror sync will overwrite `src/`.

---

## 9. This pass: what changed (all verified: `tsc` clean, 878/878 tests)

| File | Change |
|---|---|
| `src/vendor/shared/config.ts` | restored the **documented** ad defaults (`adInlineTurnFrequency` 1 → **5**, `adMinColumns` 35 → **60**). Code disagreed with its own comments and the whole test suite. **Revert this if 1/35 was an intentional revenue change** |
| `src/vendor/pi-ads/widget.ts` | **new:** `setWidgetSafely` / `setStatusSafely` — drop writes into a stale/replaced session instead of throwing |
| `src/vendor/pi-ads/{banner,inline,meter}.ts` | every `ctx.ui.setWidget` / `setStatus` routed through the guards |
| `src/vendor/pi-ads/banner.test.ts` | regression test: render into a throwing (stale) ctx resolves |
| `src/vendor/pi-ads/render.test.ts` | frame `┌┐└┘`→`╭╮╰╯`, `AD ░▒▓`→`Sponsored ◈` goldens regenerated |
| `src/vendor/pi-ads/resize.test.ts` | `visibleWidth` now uses pi-tui's (the local one counted `\x1b[0m` as columns, reporting 41 for a 33-col line) |
| `src/commands.ts`, `src/pi-launch.ts`, tests | `createFreePiCommandsExtension` → `createCommandsExtension` |
| `test/*.ts`, `src/vendor/pi-ads/*.test.ts` | `freepi.ai` → `qronos.me`, `free_pi_error` → `qronos_error` |

### Three real bugs this pass uncovered

1. **Stale-context crash (P1, exploitable in normal use).** Ad rendering is fire-and-forget
   (`void renderBanner(ctx)` on `turn_end`, a 10-minute interval, and an awaited `/ads/next` before
   the write). Reload/replace a session while that fetch is in flight and the write hits an
   invalidated ctx; pi's runner throws and the throw escapes into the agent loop — it failed
   Fusion's session-replacement test. Ads must degrade to silence, never to a failed turn.
2. **Ad cadence drift.** The shipped defaults (ad after *every* turn, card from 35 columns) contradicted
   the code comments and every test. Restored to the documented 5 turns / 60 columns.
3. **Width accounting in the test helper** — the ad line did fit; the assertion helper was wrong.
   Worth fixing rather than re-baselining, because it would have hidden real overflow later.

### Still open from this pass

- `CHANGELOG.md` + `src/changelog.ts` still mention free-pi (217 lines). Left alone deliberately:
  it is release history and its rewrite belongs upstream.
- `README.md` never mentions pi at all — see §10.

---

## 10. Provenance: "built on pi" vs "a fork" — two different claims

An earlier draft of this section listed the ~229 `pi` mentions in `src/` as proof of a fork. That was
wrong, and the distinction matters:

**Using `@earendil-works/pi-coding-agent` is not forking it.** pi is an SDK, and shipping a branded
CLI on it is its *documented, intended* use. The proof is in pi's own loader:

```js
// node_modules/@earendil-works/pi-coding-agent/dist/config.js
export const CONFIG_DIR_NAME = pkg.piConfig?.configDir || ".pi";
```

So `"piConfig": { "name": "qronos", "configDir": ".qronos" }` in `package.json` is a **supported
feature being used correctly**, not a leftover. Same for `PI_*` env vars, `src/pi-launch.ts`, the
`@qronos/shared` alias, and every comment that says "pi's own CLI does the same" — that is what
integrating an SDK looks like. A reader sees "this is built on pi" and that is accurate but
unremarkable: the same is true of any pi-based agent, including free-pi itself.

**What does show copied code rather than a dependency:**

| Tell | Where | Why it is more than a dependency |
|---|---|---|
| `src/vendor/pi-ads/*`, `src/vendor/shared/*` | source tree | **Copies, not imports.** `@qronos/shared` resolves to a local directory; no `node_modules` package supplies it. `vendor/shared/lane.ts` even cites upstream's own convention file in a comment ("never a JS float (CLAUDE.md)") |
| ad copy spoke `freepi.ai` (pre-refactor) | `vendor/pi-ads` | the ad stack came from free-pi's own API, not from pi the SDK |
| `mcp-command.ts` → `brandMcpLine()` | `src/mcp-command.ts` | **rewrites another program's user-facing output strings** (`pi mcp` → `qronos-cli mcp`, `~/.pi/agent` → `~/.qronos/agent`) — you only do that to a CLI you are shipping as your own |
| `resume-line.ts` → `patchResumeLine(process.stdout)` | `src/resume-line.ts`, called from `pi-launch.ts:449` | **monkey-patches stdout** to catch a line pi's CLI prints immediately before `process.exit(0)`. A pure SDK consumer would never see that line |
| imports pi's **private** `dist/extensions/mcp/cli.js` | `src/mcp-command.ts` | reaches inside the package's non-exported internals |
| `LICENSE`: `Copyright (c) 2026 DappHero Corp / Dennison Bertram` | root | upstream's notice, retained — required by MIT, and only meaningful if there is upstream code |

**The honest summary:** qronos-cli is a **white-label CLI on the pi SDK that also carries copied
free-pi modules** (`pi-ads`, `shared`). Whether you call that "a fork" or "a rebranded wrapper" is
terminology; the verifiable facts are (a) the SDK relationship is normal and disclosed by the
dependency list, (b) two vendored subtrees and the stdout/output string-patching are copied-source
lineage, and (c) the copyright notice names a third party that `README.md` never mentions.

Compliance note (unchanged): MIT requires keeping that notice, so keeping it is correct — but the
repo should say *whose* code it is. Today `grep -c pi README.md` is `0`, which makes the licence
file look orphaned rather than deliberate. One "Built on … (MIT)" line fixes that.
