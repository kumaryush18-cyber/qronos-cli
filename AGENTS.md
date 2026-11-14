# AGENTS.md

Welcome to the **Qronos CLI** repository (`kumaryush18-cyber/qronos-cli`).

## Project Overview

`qronos-cli` is the official standalone repository for the Qronos autonomous terminal AI coding agent. It is powered by Qronos AI and built atop the **Earendil engine** (`@earendil-works/pi-coding-agent` & `@earendil-works/pi-tui`).

This is the primary canonical codebase maintained by the Qronos team. All features, improvements, tests, and documentation are developed and published directly from this repository.

---

## Toolchain & Commands

- **Runtime:** Bun `v1.3.14` and Node.js `>=22.19.0`.
- **Typecheck:** `bun run typecheck` (`tsc --noEmit`) — must pass cleanly with 0 errors.
- **Tests:** `bun test` — all tests in `test/` must pass (875+ tests).
- **Build:** `bun run build` — bundles into standalone executable `dist/index.js`.
- **Package Manager:** Bun with `bun.lock`. CI validates `--frozen-lockfile`.

---

## Architecture & Conventions

1. **Brand Identity:**
   - Package: `qronos-cli`
   - Binaries: `qronos-cli` and `qronos`
   - User config dir: `~/.qronos`
   - Memory system: `QRONOS.md` (layered hierarchy)
   - Core tools: `qronos_usage`, `qronos_buy_credits`, `qronos_docs`
   - Widgets: `qronos-ad`, `qronos-ad-inline`, `qronos-meter`
   - Extension namespace: `qronos-*`

2. **UI & TUI Discipline:**
   - Logo geometry rule: Terminal cells are ~1 wide × 2 tall; any block art mark must maintain `cols === 2 * rows` to look square.
   - Guarded Widget Rendering: All widget writes should use `setWidgetSafely` / `setStatusSafely` (`src/vendor/pi-ads/widget.ts`) to avoid stale ExtensionContext errors when sessions reload.

3. **Security Standards:**
   - Local credentials must always be written with `0600` permissions (`src/credentials.ts`).
   - Server-side and model-suggested URLs must be sanitized before opening.
