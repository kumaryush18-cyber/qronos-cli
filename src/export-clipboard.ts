// Putting text on the clipboard from a terminal.
//
// There is no single way to do this, so we try in a fixed order:
//   1. OSC 52 — a terminal escape sequence. It works over SSH and inside
//      containers, where no clipboard program exists at all.
//   2. The platform program — `pbcopy`, `clip`, `wl-copy`, `xclip`, `xsel`,
//      `termux-clipboard-set`.
//   3. OSC 52 again, as a last try, when the program was missing.
//
// Nothing here ever throws at the caller: a copy that fails is an answer
// (`ok: false`), never a crash in the middle of an export.
import { spawn } from "node:child_process";

/** OSC 52 is small on purpose; a bigger payload is silently ignored by terminals. */
export const OSC52_MAX_ENCODED = 100_000;

export interface CopyDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Injected in tests: writes an escape sequence, resolves true when accepted. */
  writeOsc52?: (text: string) => boolean;
  /** Injected in tests: runs one clipboard program. */
  runProgram?: (command: string, args: string[], input: string) => Promise<boolean>;
}

export interface CopyResult {
  ok: boolean;
  /** `osc52`, `pbcopy`, … or `none`. Useful in a message, never required. */
  how: string;
}

function isRemote(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.SSH_CONNECTION || env.SSH_CLIENT || env.MOSH_CONNECTION || env.PI_CLIPBOARD_OSC52 === "1");
}

function defaultOsc52(text: string): boolean {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  if (encoded.length > OSC52_MAX_ENCODED) return false;
  try {
    process.stdout.write(`\u001b]52;c;${encoded}\u0007`);
    return true;
  } catch {
    return false;
  }
}

function defaultRunProgram(command: string, args: string[], input: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(ok);
    };
    const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(false);
    }, 5_000);
    child.on("error", () => finish(false));
    child.on("close", (code) => finish(code === 0));
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

/** The clipboard programs worth trying, in order, for this machine. */
export function clipboardCommands(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): Array<[string, string[]]> {
  if (platform === "darwin") return [["pbcopy", []]];
  if (platform === "win32") return [["clip", []]];
  const commands: Array<[string, string[]]> = [];
  if (env.TERMUX_VERSION) commands.push(["termux-clipboard-set", []]);
  if (env.WAYLAND_DISPLAY) commands.push(["wl-copy", []]);
  if (env.DISPLAY) commands.push(["xclip", ["-selection", "clipboard"]], ["xsel", ["--clipboard", "--input"]]);
  return commands;
}

/**
 * Copy `text`, trying the strategies above in order.
 *
 * A remote session tries OSC 52 first: the terminal that shows the output is
 * also the machine with the clipboard, so the escape sequence is the only road
 * that reaches it.
 */
export async function copyToClipboard(text: string, deps: CopyDeps = {}): Promise<CopyResult> {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const writeOsc52 = deps.writeOsc52 ?? defaultOsc52;
  const runProgram = deps.runProgram ?? defaultRunProgram;

  if (isRemote(env) && writeOsc52(text)) return { ok: true, how: "osc52" };

  for (const [command, args] of clipboardCommands(platform, env)) {
    if (await runProgram(command, args, text)) return { ok: true, how: command };
  }

  if (!isRemote(env) && writeOsc52(text)) return { ok: true, how: "osc52" };
  return { ok: false, how: "none" };
}
