// What REA can actually do on THIS machine.
//
// Why: REA is a set of bridges, not an engine bundle. Every tool group needs a
// program (or an endpoint) that already exists on the user's computer. Without
// this check the user sees "REA is loaded", asks for work, and gets
// "capability_unavailable" from a tool that was never able to run.
//
// The check is cheap and local: environment variables, PATH lookups and a few
// well-known macOS app bundles. It never downloads anything and never throws.
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

export interface ReaBackend {
  /** Short label used in the one-line summary. */
  name: string;
  ok: boolean;
  /** What the user must do when it is missing. */
  hint: string;
}

export interface DetectReaOptions {
  env?: Record<string, string | undefined>;
  platform?: string;
  /** Whether a command exists on PATH. Injected in tests. */
  hasCommand?: (command: string) => boolean;
  /** Whether an absolute path exists. Injected in tests. */
  hasPath?: (path: string) => boolean;
}

/** Programs REA shells out to, and what each one unlocks. */
const COMMANDS: ReadonlyArray<{ name: string; command: string; hint: string }> = [
  { name: "tshark", command: "tshark", hint: "packet captures (install Wireshark/tshark 4.x)" },
  { name: "adb", command: "adb", hint: "Android devices (install platform-tools)" },
  { name: "apktool", command: "apktool", hint: "APK resources (install apktool 3.x)" },
  { name: "objdump", command: "objdump", hint: "objdump views (install binutils)" },
  { name: "frida", command: "frida", hint: "runtime hooking (install frida-tools)" },
  { name: "gdb", command: "gdb", hint: "GDB sessions (install gdb)" },
  { name: "rizin", command: "rizin", hint: "Rizin sessions (install rizin)" },
  { name: "binwalk", command: "binwalk", hint: "firmware carving (install binwalk 3.x)" },
  { name: "unblob", command: "unblob", hint: "firmware extraction (install unblob)" },
];

/** Hopper lives in /Applications on macOS; the tools need its MCP bridge. */
function hopperInstalled(hasPath: (path: string) => boolean, platform: string): boolean {
  if (platform !== "darwin") return false;
  return (
    hasPath("/Applications/Hopper Disassembler.app") ||
    hasPath("/Applications/Hopper.app") ||
    hasPath(join("/Applications", "Hopper Disassembler v4.app"))
  );
}

/**
 * Lists what works right now. `ok` means "REA will not refuse for a missing
 * backend", not "the analysis will succeed".
 */
export function detectReaBackends(opts: DetectReaOptions = {}): ReaBackend[] {
  const env = opts.env ?? process.env;
  const platform = opts.platform ?? process.platform;
  const hasCommand = opts.hasCommand ?? defaultHasCommand;
  const hasPath = opts.hasPath ?? defaultHasPath;

  const python = (env.REA_PWNTOOLS_PYTHON ?? "").trim();
  const jebUrl = (env.REA_JEB_MCP_URL ?? "").trim();

  const backends: ReaBackend[] = [
    {
      name: "file id",
      // Parsing plus identification need no external program at all.
      ok: true,
      hint: "",
    },
    {
      name: "pwntools",
      ok: python !== "" && hasPath(python),
      hint: "set REA_PWNTOOLS_PYTHON to a Python with pwntools + pyelftools + unicorn",
    },
    {
      name: "jeb",
      ok: jebUrl !== "",
      hint: "start JEB with MCP on 127.0.0.1:8425, or set REA_JEB_MCP_URL",
    },
    {
      name: "hopper",
      ok: hopperInstalled(hasPath, platform),
      hint: "Hopper is macOS only; open the document and enable its MCP bridge",
    },
  ];

  for (const command of COMMANDS) {
    backends.push({
      name: command.name,
      ok: hasCommand(command.command),
      hint: command.hint,
    });
  }

  return backends;
}

function defaultHasPath(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}

function defaultHasCommand(command: string): boolean {
  try {
    // `which` is POSIX, `where` is Windows. Both are cheap and silent.
    const finder = process.platform === "win32" ? "where" : "which";
    const result = spawnSync(finder, [command], { timeout: 2_000, stdio: "ignore" });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * One short line for the user: "<name>: ok/no" plus the first missing hints.
 *
 * Kept short on purpose: the message goes into a notification, not a log file.
 */
export function summarizeReaBackends(backends: ReaBackend[], maxHints = 3): string {
  const ready = backends.filter((b) => b.ok).map((b) => b.name);
  const missing = backends.filter((b) => !b.ok);
  const parts = [`REA on this machine — ready: ${ready.join(", ") || "nothing"}`];
  if (missing.length === 0) {
    parts.push("every backend found");
  } else {
    const hints = missing
      .slice(0, maxHints)
      .map((b) => `${b.name} (${b.hint})`)
      .join("; ");
    const rest = missing.length > maxHints ? `; +${missing.length - maxHints} more` : "";
    parts.push(`missing: ${hints}${rest}`);
  }
  return parts.join(" · ");
}
