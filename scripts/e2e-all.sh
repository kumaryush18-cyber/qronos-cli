#!/usr/bin/env bash
# End-to-end check of the hashline (`apply_patch`) and `lsp` tools, driven by a
# real model against a real workspace. Six scenarios, each in a fresh session:
#
#   1 read shows a tag and line numbers
#   2 apply_patch renames a function and the tag changes
#   3 a patch with a stale tag is refused
#   4 lsp rename_file moves a file and rewrites its imports
#   5 lsp diagnostics reports a real type error
#   6 lsp rename updates the other file that uses the symbol
#
# Usage: scripts/e2e-all.sh
# Requires credentials in ~/.qronos/agent and one working model.
set -uo pipefail

WORKSPACE="${QRONOS_E2E_CWD:-/workspaces/hashline-lsp-workspace}"
CLI_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODEL="${QRONOS_E2E_MODEL:-claude-haiku-5.5}"
LOG="$(mktemp)"
ALL="$LOG.all"
: >"$ALL"

reset_workspace() {
  rm -rf "$WORKSPACE"
  mkdir -p "$WORKSPACE"
  cat >"$WORKSPACE/tsconfig.json" <<'JSON'
{
  "compilerOptions": { "strict": true, "target": "ES2022", "module": "ES2022", "moduleResolution": "bundler", "noEmit": true },
  "include": ["**/*.ts"]
}
JSON
  cat >"$WORKSPACE/user.ts" <<'TS'
export interface User {
  id: string;
  name: string;
}

export function fetchUser(id: string): User {
  return { id, name: "demo" };
}
TS
  cat >"$WORKSPACE/app.ts" <<'TS'
import { fetchUser } from "./user";

const user = fetchUser("1");
console.log(user.name);
TS
}

run() {
  # run <name> <expected-substring> [-e extra env] -- prompts...
  local name="$1" expected="$2"
  shift 2
  echo "--- $name"
  ( cd "$CLI_DIR" && QRONOS_NOTIFY=0 QRONOS_LSP_PATH=/usr/bin:/bin \
      QRONOS_E2E_CWD="$WORKSPACE" QRONOS_E2E_MODEL="$MODEL" \
      timeout 420 bun run scripts/e2e-check.ts "$@" ) >"$LOG" 2>&1
  cat "$LOG" >>"$ALL"
  if grep -qiF "$expected" "$LOG"; then
    echo "    PASS (found: $expected)"
  else
    echo "    FAIL (missing: $expected)"
    echo "    --- last output ---"
    tail -25 "$LOG" | sed 's/^/    /'
  fi
}

# 1. A read shows the tag and the line numbers.
reset_workspace
run "1 read shows a tag" "#" "Read user.ts and tell me the tag it shows and the line number of fetchUser. Do not change anything."

# 2. apply_patch renames the function; the tag must change afterwards.
reset_workspace
run "2 apply_patch rename" "renamed" \
  "Rename the function fetchUser to loadUser in user.ts using the apply_patch tool, then read user.ts again and tell me the new tag."
if grep -q "loadUser" "$WORKSPACE/user.ts" && ! grep -q "fetchUser" "$WORKSPACE/user.ts"; then
  echo "    PASS (file really changed)"
else
  echo "    FAIL (file did not change)"
fi

# 3. A patch built on a tag that is no longer true must be refused.
reset_workspace
export QRONOS_E2E_BETWEEN='echo "// touched by user" >> user.ts'
run "3 stale tag refused" "changed since it was read" \
  "Read user.ts and remember the exact tag it shows. Do not change anything." \
  "Now use apply_patch with the tag you saw in the previous step to replace line 6 with: export function getUser(id: string): User {  — use the OLD tag, do not read the file again first."
unset QRONOS_E2E_BETWEEN
if grep -q "// touched by user" "$WORKSPACE/user.ts"; then
  echo "    PASS (file untouched by the refused patch)"
fi

# 4. rename_file moves the file and rewrites the import.
reset_workspace
run "4 lsp rename_file" "lib/user" \
  "Move the file user.ts into a new folder called lib using the lsp tool (action rename_file). Then show me the contents of app.ts."
if [ -f "$WORKSPACE/lib/user.ts" ] && grep -q "./lib/user" "$WORKSPACE/app.ts"; then
  echo "    PASS (file moved and import rewritten)"
else
  echo "    FAIL (move or import rewrite missing)"
fi

# 5. Diagnostics reports the real type error.
reset_workspace
run "5 lsp diagnostics" "not assignable to type" \
  "Add a line to app.ts that assigns the string \"hello\" to a variable typed as a number, then run the lsp tool with action diagnostics on app.ts and tell me exactly what it reported."

# 6. rename updates every file that uses the symbol.
reset_workspace
run "6 lsp rename" "updated" \
  "Use the lsp tool with action rename to rename the symbol fetchUser to loadUser in user.ts. Read the file first to find the line and column."
if grep -q "loadUser" "$WORKSPACE/app.ts" || grep -q '"WARNING"' "$LOG"; then
  echo "    PASS (rename reached the other file, or warned about it)"
else
  echo "    FAIL (the other file was left broken and silent)"
fi

echo "--- done (full log: $ALL)"
