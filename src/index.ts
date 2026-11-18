// Bin entry SHIM. This runs the Node-capability guard BEFORE any static import
// that would load undici.
//
// Why a shim and not a check inside main(): `run.ts` / `pi-launch.ts` do *value*
// imports from `@earendil-works/pi-coding-agent`, which loads undici@8.9.0 at
// module-load time. ES-module imports are hoisted, so on an old Node undici's own
// load crashes (e.g. `webidl.util.markAsUncloneable` on Node 20) — or, one notch
// newer, it loads fine but later crashes on `zlib.createZstdDecompress` — BEFORE
// any guard placed in main() could run. This bit us in 0.2.3, which put the guard
// in main() and so only caught the zstd window, not the older undici-load crash.
//
// This module imports ONLY `node:zlib` + `./node-check` (neither loads undici), so
// it evaluates cleanly on ANY Node. It checks zstd support, prints a friendly
// message and exits on failure, and only then dynamically imports the real CLI —
// which is when undici finally loads, on a runtime we've confirmed can handle it.
import * as zlib from "node:zlib";
import { APP_TITLE_TEXT } from "./app-title";
import { zstdSupportError } from "./node-check";

// Name the OS process, not just the window title.
//
// `npm i -g qronos-cli` installs a small shim that runs `node dist/index.js`, so
// every OS that lists a process by its command shows "node": VS Code's terminal
// tab (its default title is ${process}), the Windows Task Manager, `ps`. Node can
// rename the process (argv[0] + PR_SET_NAME on Linux/macOS), which makes those
// places read the app name even before the window title is set.
//
// Windows ignores this (there the console title, set by the app, is what shows).
try {
  process.title = APP_TITLE_TEXT;
} catch {
  // Some sandboxes refuse the rename; the window title still works.
}

const err = zstdSupportError(zlib, process.versions.node);
if (err) {
  console.error(err);
  process.exit(1);
}

// Guard passed: load the real CLI (this is where undici gets pulled in).
await import("./main");
