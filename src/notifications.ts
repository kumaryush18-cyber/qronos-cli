// Desktop notifications for long turns, ported in spirit from oh-my-pi.
//
// Why: a long agent run is exactly the moment the user switches to another
// window. Without a notification they come back to a finished run — or worse, to
// a permission prompt that has been waiting for minutes.
//
// There is no cross-platform API here, so we emit terminal escape sequences:
//   OSC 9   ; text ST   -> iTerm2, WezTerm, Ghostty, Windows Terminal, ConEmu
//   OSC 777 ; notify ; title ; body ST -> rxvt-unicode, Konsole
// Unsupported terminals ignore unknown OSC sequences, but we still detect first
// and stay silent when we are not sure, so a notification never corrupts a
// screen redraw.
//
// Switch: QRONOS_NOTIFY=0 turns it off, QRONOS_NOTIFY=1 forces OSC 9.
/** String Terminator for an OSC sequence. */
const ST = "\x1b\\";

export type NotifyProtocol = "osc9" | "osc777" | "none";

const FALSY = new Set(["0", "false", "no", "off"]);
const TRUTHY = new Set(["1", "true", "yes", "on"]);

/** Terminals that implement OSC 9 as a desktop notification. */
const OSC9_TERM_PROGRAMS = new Set(["iterm.app", "wezterm", "ghostty", "vscode", "hyper"]);
/** Terminals that implement the rxvt/Konsole OSC 777 form. */
const OSC777_TERM_PROGRAMS = new Set(["konsole"]);

export function detectNotifyProtocol(env: Record<string, string | undefined> = {}): NotifyProtocol {
  const termProgram = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (OSC9_TERM_PROGRAMS.has(termProgram)) return "osc9";
  if (OSC777_TERM_PROGRAMS.has(termProgram)) return "osc777";
  if (env.WT_SESSION) return "osc9"; // Windows Terminal
  if (env.KONSOLE_VERSION) return "osc777";
  if (env.VTE_VERSION && (env.TERM ?? "").includes("rxvt")) return "osc777";
  return "none";
}

/** Notification is on unless it is explicitly off, or unsupported and unforced. */
export function notificationsEnabled(env: Record<string, string | undefined> = {}): boolean {
  const raw = (env.QRONOS_NOTIFY ?? "").trim().toLowerCase();
  if (FALSY.has(raw)) return false;
  if (TRUTHY.has(raw)) return true;
  return detectNotifyProtocol(env) !== "none";
}

export function resolveNotifyProtocol(env: Record<string, string | undefined> = {}): NotifyProtocol {
  const raw = (env.QRONOS_NOTIFY ?? "").trim().toLowerCase();
  if (FALSY.has(raw)) return "none";
  const detected = detectNotifyProtocol(env);
  if (detected !== "none") return detected;
  return TRUTHY.has(raw) ? "osc9" : "none";
}

/**
 * Escape sequences must never contain their own terminators, and a shell title
 * with a newline breaks the redraw. Strip control characters, keep it short.
 */
export function sanitizeNotificationText(text: string, limit = 200): string {
  const cleaned = (text ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= limit ? cleaned : `${cleaned.slice(0, limit - 1)}…`;
}

export function notificationSequence(protocol: NotifyProtocol, title: string, body: string): string {
  const safeTitle = sanitizeNotificationText(title, 64);
  const safeBody = sanitizeNotificationText(body);
  if (protocol === "osc9") return `\x1b]9;${safeTitle}: ${safeBody}${ST}`;
  if (protocol === "osc777") return `\x1b]777;notify;${safeTitle};${safeBody}${ST}`;
  return "";
}

export interface NotifierOptions {
  env?: Record<string, string | undefined>;
  /** Terminal writer; defaults to process.stdout.write. */
  write?: (chunk: string) => void;
}

export type Notifier = (title: string, body: string) => void;

/**
 * Build the notify function once at startup: detection and the env switch are
 * read here, not on every turn, so a turn cannot be slowed by them.
 */
export function createNotifier(options: NotifierOptions = {}): Notifier {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const protocol = resolveNotifyProtocol(env);
  const write = options.write ?? ((chunk: string) => process.stdout.write(chunk));
  return (title, body) => {
    if (protocol === "none") return;
    const sequence = notificationSequence(protocol, title, body);
    if (!sequence) return;
    try {
      write(sequence);
    } catch {
      // A notification is never worth an error in the session.
    }
  };
}

/** Turn-end message: short, and says whether anything needs the user. */
export function turnEndMessage(options: { aborted?: boolean; hadError?: boolean; seconds?: number }): string {
  if (options.hadError) return "Something went wrong — open Qronos CLI";
  if (options.aborted) return "Stopped — back to you";
  const time = options.seconds && options.seconds >= 60 ? ` after ${Math.round(options.seconds / 60)} min` : "";
  return `Done${time}`;
}
