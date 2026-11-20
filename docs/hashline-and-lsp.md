# Hashline edits and the language server

Two features ported from [oh-my-pi](https://github.com/can1357/oh-my-pi) in November 2026.

## 1. `apply_patch` — edit by line range

Every `read` now shows a tag and line numbers:

```
[src/api/users.ts#a3f1] (240 lines)
  1| import { db } from "./db";
  2|
 42| export async function fetchUser(id: string) {
 43|   return db.query("select * from users where id = ?", [id]);
 44| }
```

To change lines 42–44, the model sends only the new lines:

```
*** Begin Patch
[src/api/users.ts#a3f1]
PUT 42.=44:
+export async function loadUser(id: string) {
+  return db.query("select * from users where id = ?", [id]);
+}
*** End Patch
```

Why this is better than exact-text editing for big files: a three-line change to a 400-line file costs three lines of output, not thirty. And the tag `#a3f1` is a hash of the whole file, so if the file changed after the read, the patch is **refused before anything is written**. The next read shows the new tag.

Operations:

| Op | Meaning |
|---|---|
| `PUT N.=M:` | replace lines N to M with the `+` body |
| `PUT <N:` | insert the body before line N |
| `PUT >N:` | insert the body after line N |
| `PUT >$:` | append at the end of the file |
| `CUT N.=M` | delete lines N to M |
| `REM` | delete the file |
| `MV dest` | move or rename the file |

Body lines start with `+`. A lone `+` writes a blank line. Write `++text` for a literal `+text` and `+- text` for a literal `- text`.

Not supported yet: block operations (`N*`) and clipboard registers (`@name`). They are rejected with a clear message rather than half-applied.

`edit` **is still available**. Use `edit` for a single-line change, `apply_patch` when several lines change at once. Turn the feature off completely with `QRONOS_HASHLINE=0` (that also returns reads to plain, unnumbered output).

### Safety rules the tool enforces

- A patch needs a prior read in the same session (no tag, no write).
- A stale tag is refused, and nothing is written.
- Line ranges past the end of the file, overlapping ranges, and reversed ranges are refused.
- A patch whose result is byte-identical to the original is reported as an error, because it almost always means the wrong line numbers.
- Writes go through pi's own `write` tool, so permissions, hooks and the transcript behave exactly as before.

## 2. `lsp` — ask the language server

| Action | What it does |
|---|---|
| `rename` | rename a symbol; every reference in the project is updated |
| `rename_file` | move a file **and** rewrite the imports (`workspace/willRenameFiles`) |
| `diagnostics` | the compiler's errors and warnings for a file |
| `hover` | the type of the expression at a position |

Example: "move `Button.tsx` into `components/ui/`". By hand the agent edits six importers and usually misses one. Through `rename_file`, TypeScript rewrites them itself, so the project still compiles.

**TypeScript needs no setup.** The TypeScript server and compiler ship inside `qronos-cli` as optional dependencies, so `lsp` works on a fresh install. A project-local TypeScript still wins, because a project should be edited with the compiler it was written against. Other languages are **not** bundled — their servers are large and versioned with their toolchains — so for those the tool says what to install.

The TypeScript server also needs a TypeScript install it can drive. Qronos CLI looks for it in this order: `QRONOS_TSSERVER_PATH`, then the project's own `node_modules/typescript`, then the one beside a global `tsc`. It is passed to the server through `initializationOptions`, because `typescript-language-server` 6 removed the `--tsserver-path` flag.

| Language | Server | Install |
|---|---|---|
| TypeScript / JavaScript | `typescript-language-server` | `npm install -g typescript-language-server typescript` |
| Python | `pyright-langserver` | `npm install -g pyright` |
| Rust | `rust-analyzer` | `rustup component add rust-analyzer` |
| Go | `gopls` | `go install golang.org/x/tools/gopls@latest` |

A server is started the first time it is needed, reused for the session, and killed on exit. Requests time out after 5 seconds, so a hung server cannot freeze the CLI.

`diagnostics` waits up to 8 seconds for the compiler, because the first request in a session pays for loading the project (measured at about 2.5 seconds on a small repo). TypeScript answers twice: a quick syntax-only pass, then the real type check about a second later. The tool therefore trusts an answer only after the compiler has been quiet for 1.2 seconds, otherwise a broken file would be reported as clean. If nothing arrives at all it says "no answer from the compiler", which is not the same as "no problems".

For `rename_file` to find the importers, the project needs a `tsconfig.json` (or equivalent) so the compiler knows which files belong to it. Without one, TypeScript only knows the files that were opened, and the server may report "no import changes were needed".

## End-to-end check

`scripts/e2e-all.sh` runs six real scenarios against a scratch workspace, with a
real model and the real tools: read shows a tag, `apply_patch` renames a
function, a stale tag is refused, `rename_file` moves a file and rewrites its
imports, `diagnostics` reports a type error, and `rename` updates the other file
that uses the symbol. It prints PASS/FAIL per scenario.

```bash
scripts/e2e-all.sh                       # all six, ~6 minutes
bun run scripts/e2e-check.ts "a prompt"  # one prompt, prints every tool call
```

`QRONOS_E2E_CWD` chooses the workspace, `QRONOS_E2E_MODEL` the model, and
`QRONOS_E2E_BETWEEN` runs a shell command between two prompts (used to change a
file behind the model's back and prove the stale tag is refused).
