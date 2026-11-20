// Tests for the generated completion scripts. Two kinds of check:
//  1. the scripts mention every flag/subcommand, so a new flag cannot ship
//     without completions,
//  2. `bash -n` parses the bash script, and `zsh -n` the zsh script when zsh is
//     installed, so a quoting mistake fails CI instead of a user's login shell.
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPLETION_SPEC,
  COMPLETION_SHELLS,
  completionInstallHint,
  completionScript,
  isCompletionShell,
} from "../src/completions";

function commandsAvailable(binary: string): boolean {
  try {
    execFileSync("sh", ["-c", `command -v ${binary}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

describe("completionScript", () => {
  test("knows exactly the three supported shells", () => {
    expect([...COMPLETION_SHELLS]).toEqual(["bash", "zsh", "fish"]);
    expect(isCompletionShell("bash")).toBe(true);
    expect(isCompletionShell("powershell")).toBe(false);
  });

  for (const shell of COMPLETION_SHELLS) {
    test(`${shell}: mentions every long flag and every subcommand`, () => {
      const script = completionScript(shell);
      for (const flag of COMPLETION_SPEC.flags) {
        const name = shell === "fish" ? flag.long.replace(/^--/, "") : flag.long;
        expect(script).toContain(name);
      }
      for (const sub of COMPLETION_SPEC.subcommands) {
        expect(script).toContain(sub.name);
      }
      for (const provider of COMPLETION_SPEC.providers) {
        expect(script).toContain(provider);
      }
    });

    test(`${shell}: is not empty and ends with a newline`, () => {
      const script = completionScript(shell);
      expect(script.length).toBeGreaterThan(200);
      expect(script.endsWith("\n")).toBe(true);
    });
  }

  test("bash: parses cleanly with bash -n", () => {
    if (!commandsAvailable("bash")) return;
    const dir = mkdtempSync(join(tmpdir(), "qronos-completion-"));
    const file = join(dir, "qronos-cli.bash");
    writeFileSync(file, completionScript("bash"));
    // Throws (and fails the test) on a syntax error.
    execFileSync("bash", ["-n", file], { stdio: "pipe" });
  });

  test("zsh: parses cleanly with zsh -n when zsh exists", () => {
    if (!commandsAvailable("zsh")) return;
    const dir = mkdtempSync(join(tmpdir(), "qronos-completion-"));
    const file = join(dir, "_qronos-cli");
    writeFileSync(file, completionScript("zsh"));
    execFileSync("zsh", ["-n", file], { stdio: "pipe" });
  });

  test("bash: quotes a value containing an apostrophe safely", () => {
    const script = completionScript("bash", {
      ...COMPLETION_SPEC,
      providers: ["plain", "it's-odd"],
    });
    expect(script).toContain("'\\''");
  });
});

describe("completionInstallHint", () => {
  test("names the right file per shell", () => {
    expect(completionInstallHint("bash")).toContain(".bash_completion");
    expect(completionInstallHint("zsh")).toContain("fpath");
    expect(completionInstallHint("fish")).toContain(".config/fish");
  });
});
