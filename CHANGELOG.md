# Changelog

All notable changes to `qronos-cli`. Format based on [Keep a Changelog](https://keepachangelog.com/).

The short highlights shown in the CLI at startup live in `src/changelog.ts` (bundled into the
build); this file is the fuller human record.

## [1.0.5] - 2026-11-18

Editor and terminal polish, plus the "node" name fixed for good.

### Added
- The working line now shows the real context size next to the spinner, e.g.
  `⠋ ↓ 12.3k`. The number comes from the live session (`getContextUsage`), never a
  guess, and falls back to a plain spinner when the size is unknown.
- **Fullscreen is the default TUI mode.** That is what lets the terminal report mouse
  clicks, so a click inside the input box puts the cursor where you clicked.
  `QRONOS_TUI_MODE=regular` restores the old inline mode with native scrollback.
- `QRONOS_TITLE` sets the text of the terminal tab / window title.

### Fixed
- Ctrl+C no longer throws away a half-typed prompt. It is unbound; Escape still
  interrupts and Ctrl+D still exits. The defaults are written into
  `~/.qronos/agent/keybindings.json` only when a key is missing.
- The `@` file list now closes the moment the `@` is deleted (rows are cleared on
  shrink instead of waiting for the next key press).
- The OS process and the window title say **Qronos CLI** instead of `node`, so VS Code
  tabs and the process list show the product name.
- `/paste-image` builds its clipboard commands with argument arrays (no shell string),
  and saves to `screenshots/` instead of mixing with generated images.
- Model facts (context window, max output, price) come from a reviewed table instead of
  a fake 1M window and `$0` cost; unknown models get a safe 128k window and are labelled
  as unknown.
- The session argument is parsed once, by `cli-args.ts`, instead of twice.
- CI publishes only after `typecheck`, `test` and `build` pass, and never runs two
  publishes at once.

## [1.0.0] - 2026-11-12

The rename release. One product name everywhere, and the setup screen users asked for.

### Changed
- The tool is now **qronos-cli** throughout: config lives in `~/.qronos`, and the help,
  error messages, prompts and resume hints all say qronos. `piConfig` in `package.json`
  makes the underlying agent library use the same name and config directory.
- Environment variables are standardized to `QRONOS_*`.

### Added
- First-run setup offers two explicit choices: sign in to the Qronos Gateway, or bring your
  own API key. A failed sign-in returns to the menu rather than dead-ending.
- Returned the startup consent check: a returning user with an outdated or never-recorded
  consent version is re-prompted, and a revoked token is detected and cleared instead of
  being used for a whole session.

### Fixed
- An offline or 5xx `/me` response no longer aborts startup.
- A server-reported model now wins over the built-in default, so trial model routing works.
- `qronos logout --force` reports the stray argument instead of silently ignoring it.
- The resume hint suggests `npx qronos-cli`, which works whether or not the CLI is installed
  globally.
- Test isolation: the plan-mode tests no longer leave execution mode set to plan for every
  later session in the same process.

## [0.4.10] - 2026-10-21

### Added
- Generated images now display inline in terminals that support it (iTerm2, Kitty, Ghostty,
  WezTerm, Warp). Inside tmux and in other terminals you still get the saved file path.

## [0.4.9] - 2026-10-21

### Changed
- 🧨 Fusion is now much cheaper: DeepSeek V4 Pro plans and DeepSeek V4 Flash builds, so each Fusion
  turn uses a small fraction of the allowance it used to. The server now chooses the two models
  (`fusion` in `/client-version`); an older server without DeepSeek V4 Pro keeps the previous
  Argon plans, DeepSeek builds pairing.
- Fusion is listed first in the `/model` picker. The default model at startup is unchanged.

## [0.4.8] - 2026-10-21

### Added
- `generate_image` tool: the agent can create images (mockups, icons, illustrations) through the
  qronos server and saves each one into `images/` in your project. Each image counts toward your
  daily allowance.

### Changed
- Limit messages now say when the limit clears and how many credits are left today. On the slow
  lane, the message explains the hourly limit and points to qronos.me/account.
- A session-conflict message keeps its `/close-other-session` hint.

## [0.4.7] - 2026-10-20

### Changed
- qronos now updates itself when a new version is required: it relaunches through
  `npx --yes qronos-cli@<latest>` instead of asking you to run `npx qronos-cli@latest`.
  Set `QRONOS_NO_AUTO_UPDATE=1` to opt out.
- The ad box redraws at your terminal's width after a resize, and never overflows with wide
  characters.

### Notes
- Global installs (`npm i -g`) still update and ask you to re-run once.

## [0.4.6] - 2026-10-20

### Added
- Free web search and free documentation lookup: the agent can now search the web (`web_search`)
  and look up current library docs (`docs_lookup`). Both run on the qronos server and count
  toward your daily allowance.

## [0.4.5] - 2026-10-19

### Added
- `/reverse-engineer-anything` loads REA (Reverse Engineer Anything) reverse-engineering tools into
  the current session. Inspect JavaScript/Electron apps, .NET assemblies, Go/Rust binaries, APKs,
  websites and native binaries (with your own Ghidra, Hopper or IDA). It downloads `rea-agents` on
  first use and needs Node 22.19+, 24.11+ or 26+. Use it for lawful, authorized analysis only.

## [0.4.4] - 2026-10-19

### Changed
- Consent version 4: the terms now also say that Gravity keeps a session and visitor ID in
  `~/.qronos/gravity` and receives usage events from qronos. Existing users are asked to accept
  once.
- Ads served by Gravity are measured with Gravity's terminal pixel, which starts only after you
  accept the current terms. Disable it with `QRONOS_NO_GRAVITY_PIXEL=1`.
- The CLI now fires Gravity's impression pixel itself when a Gravity ad is shown.
- No other ad is shown beside a Gravity ad (Gravity's publisher rule): qronos's own banner and
  inline ads step aside while a Gravity ad is on screen.

## [0.4.3] - 2026-10-19

### Changed
- The ad banner refreshes when the model finishes a step, at most once a minute (the 10-minute
  refresh remains as an idle fallback). A slow ad fetch never delays the agent.
- Ad requests wait up to 5 s (was 3 s).

### Added
- Users whose saved consent is older than the current version see the consent screen at startup.
  Accepting records it; declining exits, and the screen is shown again next time.

## [0.4.2] - 2026-10-14

### Changed
- Credits now sit on the right of the footer, under the model name.

## [0.4.1] - 2026-10-14

### Added
- A credits meter ("<n> credits") in the footer status bar. If you have bought credits, it reads
  "<free> + <bought> credits".
- A warning line when 10% or less of your daily credits are left, and another when you are in the
  slow lane. Each links to qronos.me/account.
- `/usage` now shows "X / Y credits left today" with the refill time, the slow-lane line when it
  applies, and a final "buy more credits: /buy-credits" line.

## [0.4.0] - 2026-10-13

### Added
- A `todo` tool the agent uses to track multi-step work, and a `/todos` command that shows the list.
  The open items show live above the input box (a one-line form, or a short list in a narrow
  terminal), each todo change prints a progress line in the conversation, and the list is stored in
  the session, so it follows branches and comes back on resume.
- MCP server support. You add your own servers (qronos bundles none) in
  `~/.qronos/agent/mcp.json`, or in a trusted project's `.pi/mcp.json`. The agent reaches their
  tools through its `codemode` tool, and `/mcp` manages the servers inside a session.
- `qronos-cli mcp add|remove|list|login|logout`: manage MCP servers from a shell.

## [0.3.0] - 2026-10-13

### Changed
- Upgraded the underlying pi agent engine to 1.2.0; pi's install telemetry is disabled.

### Added
- `/bug` sends bug reports to the qronos server.

### Fixed
- `qronos-cli --session <id>` resumes a session. It was rejected as an unknown argument, and the
  printed resume command included a `--session-dir` flag the CLI does not accept.

## [0.2.18] - 2026-09-04

### Changed
- The startup consent line reads "Usage is funded by ads and training." instead of naming sessions
  directly.

## [0.2.17] - 2026-09-03

### Added
- `/tos` and `/privacy-policy` slash commands: open the Terms of Service and Privacy Policy in
  your browser.
- The consent screen and startup header now state that usage is funded by ads and by training
  on your sessions.

## [0.2.16] - 2026-09-03

### Added
- The whole ad card is one clickable link. Every row of the card carries the same link, so a
  click anywhere on the card opens the advertiser.
- `qronos_docs` tool: the agent can answer questions about qronos itself (what it is, the
  free allowance, credits, and the slash commands) from a built-in guide.

## [0.2.15] - 2026-09-03

### Added
- A qronos startup screen: name and model, a welcome line, and the five qronos commands
  (`/usage`, `/support`, `/buy-credits`, `/close-other-session`, `/update`). `ctrl+o` shows one line
  of key hints. pi's own startup header, skill list, and extension list no longer print.
- `/support` slash command: opens the advertiser currently shown in the banner. It grants nothing.

## [0.2.12] - 2026-09-01

### Added
- `/buy-credits` slash command (#241): opens the buy page with no model turn, so it works when
  you are out of usage and every request is rejected.
- `/usage` slash command: the same report as `qronos_usage`, with no model turn.
- One readable line when the server rejects a request with a 429: the server's own buy notice at
  the wall, or a plain rate-limit line with the retry time. pi still prints its raw error and
  retries; this line sits beside it.
- A heads-up in the meter from 80% of the free daily allowance (server-owned text).
- A one-turn "Payment received — $X of usage added" line in the meter when a purchase lands.

### Changed
- `qronos_usage` reports free usage as a percentage of today's allowance (#242). No free-usage
  dollar figure is shown anywhere (cap, spend, lifetime). Purchased credit stays in dollars.

## [0.2.11] - 2026-09-01

### Added
- **Buy more usage when the free daily cap is hit** (epic #221). A purchased credit balance
  covers usage above the free allowance and persists across days. Packs: $5 → $4.00 of usage,
  $10 → $8.00, paid by card or USDC through Stripe Checkout.
- `qronos_buy_credits` tool (#226): ask qronos to buy credits and it opens the buy page in your
  browser and prints the URL (for SSH sessions).
- `qronos_usage` now shows the purchased balance (#227).

### Changed
- The out-of-usage line in the meter is now server-supplied (#225), so the offer and link can
  change without a CLI update. Against an older server the previous text is shown unchanged.

## [0.2.10] - 2026-08-29

### Changed
- **qronos now pins the exact agent version it was tested against.** The dependency on
  `@earendil-works/pi-coding-agent` was a `^0.84.2` range, and because the build marks it
  external it resolved on *your* machine at install time — so a fresh install was already
  pulling 0.84.4, a version qronos had never run a test against. Nobody chose that; npm did.
  It is now pinned to `0.84.4` (tested: 178 CLI tests, typecheck, build, and a real session with
  the ad banner, model-lock and all five extensions loaded). Adopting a newer agent is now a
  deliberate release rather than something that happens to you.
- A nightly CI canary runs the CLI against the *newest* agent release, so a breaking upstream
  change shows up as a red job instead of a user's broken install.

## [0.2.9] - 2026-08-28

Windows fixes and the first cross-platform CI, all from community pull requests by
[@andreolf](https://github.com/andreolf) on the public repo.

### Fixed
- **Windows: self-update never ran.** `npm` on Windows is `npm.cmd`, a batch file, and Node
  refuses to spawn one without a shell. The resulting error was read as "not updatable", so every
  Windows launch silently skipped the update since the feature shipped. The same bug made
  `/update` fail too.
- **Windows: sign-in never opened a browser.** `start` treats its first quoted argument as a
  window title, so the sign-in URL opened an empty console window instead of a browser.
- **Non-interactive runs no longer hang or silently do nothing.** With stdin piped from something
  that never sends a line (CI, `cat | qronos-cli`), first-run consent waited forever. With stdin
  closed (`< /dev/null`) it printed the consent screen and exited 0 without consenting or
  launching — a success that did nothing. Both now print one line explaining that consent needs a
  terminal, and exit 1.

### Added
- `qronos-cli logout` — removes the stored sign-in token; the next run signs in again. Purely
  local, so it works offline. Note there is no server-side revoke: the token stays valid until it
  expires.
- `qronos-cli --version` and `--help`.
- An unrecognized argument now prints help and exits 2, instead of quietly starting a full agent
  session on a typo.

### Security
- The sign-in URL is validated before it is handed to a shell. It arrives from the server and was
  previously passed through with only `&` escaped, which on Windows left `|`, `(` and `)` able to
  run a command. It must now parse as an http/https URL, and every shell metacharacter is escaped.

## [0.2.8] - 2026-08-22

### Added
- Model picker. When the server offers more than one model, `/model` lists them and lets you
  switch; the picker is scoped to exactly the qronos models. Backed by a server-side model
  catalog, so models can be added or changed without a CLI release. Older CLIs are unaffected —
  they keep using the single active model.

## [0.2.7] - 2026-08-21

### Changed
- The model-lock is now reliable and no longer touches your environment. 0.2.6 hid extra
  providers by deleting their API-key env vars before startup, which (a) missed HuggingFace
  (its token is `HF_TOKEN`, not `*_API_KEY`) and (b) could not hide providers discovered from
  dual-use credentials (AWS Bedrock, Google Vertex) without also deleting those credentials —
  which the agent's shell tool legitimately needs. The lock now leaves every credential in your
  shell intact and instead scopes the model picker to just the qronos model. Set
  `QRONOS_KEEP_ENV_PROVIDERS=1` to unlock the picker and use your own providers.

## [0.2.6] - 2026-08-21

### Added
- `/close-other-session` — clear a stuck or orphaned session yourself, instead of waiting out the
  timeout, when you hit "you've already got a qronos session running somewhere". Force-releases
  only your own account's session lease; the one-session-per-account limit is unchanged.
- `/whats-new` — show recent release highlights on demand.
- `/update` — update qronos-cli to the latest version (a no-op on `npx`, which is always latest).
- "What's new" note shown once at startup after you update to a newer version.

### Changed
- The model list is now limited to the qronos model instead of inheriting every provider whose
  API key happens to be in your shell (which silently bypassed qronos). Bring your own key
  deliberately with `/login`, or set `QRONOS_KEEP_ENV_PROVIDERS=1` to keep your shell's provider
  keys.

## [0.2.5] - 2026-08-21

### Added
- The CLI now shows the model the server is actually serving (accurate status-line label) plus a
  one-line notice for trial models.
- Free **Ox Alpha** trial — a frontier preview model, free for the trial period.

## [0.2.4] - 2026-08-20

### Fixed
- Moved the Node-version guard into the bin shim so even very old Node versions get a friendly
  message instead of crashing mid-startup (undici/zstd).

## [0.2.3] - 2026-08-20

### Added
- Preflight check for Node zstd support: a clear "upgrade your Node" message instead of a crash
  mid-request.
