// 0.4.2: pi appends extension statuses (the credits meter) as one extra footer
// line, left-aligned, and collapses any padding we put in the status text. So we
// wrap the footer's render() on our own InteractiveMode instance and right-align
// that last line. pi assigns `mode.footer` once, in its constructor.
//
// 0.5.0: the execution-mode line is prepended above pi's own footer lines. It is
// a marker, not a status, so it keeps its left alignment; only pi's last line —
// the credits status the user scans — is right-aligned.
import { exec } from "node:child_process";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { getExecutionModeStatusLine } from "./execution-modes";
import { getLatestContextStats, renderContextFooterTag } from "./context-view";

const ANSI = /\x1b\[[0-9;]*m/g;
const SIMPLE = /^[\x20-\x7e\xa0-\xff]*$/;

/** Visible width after stripping SGR color codes. */
function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

export interface FooterAlignOptions {
  statusLineCommand?: string;
  getStatusLine?: () => string | undefined;
  /** Injected in tests; must not block. */
  statusLineRunner?: (command: string, cb: (raw: string | undefined) => void) => void;
}

/** How long a status-line result is reused before the command runs again. */
export const STATUS_LINE_TTL_MS = 5000;
/** A status command that runs longer than this is killed. */
export const STATUS_LINE_TIMEOUT_MS = 2000;
/** Cap on a status line's output; it is one line of footer, not a report. */
export const STATUS_LINE_MAX_CHARS = 200;

/**
 * Cached status line, refreshed off the render path.
 *
 * The first version called execSync(..., timeout: 2000) *inside*
 * footer.render(). Render runs many times per second while streaming, so a slow
 * `git status` blocked the event loop for up to 2s per frame and froze the TUI.
 *
 * Now render only ever reads `cached.value`; `refresh()` schedules the command
 * in the background. Until the first result arrives the footer shows nothing,
 * which is correct — a blank segment is better than a stalled UI.
 */
export interface StatusLineCache {
  value: string | undefined;
  lastRun: number;
  inFlight: boolean;
}

export function createStatusLineCache(): StatusLineCache {
  return { value: undefined, lastRun: 0, inFlight: false };
}

/** First line of output, trimmed and bounded. Empty output clears the line. */
export function firstStatusLine(raw: string): string | undefined {
  const line = raw.split("\n").find((l) => l.trim() !== "")?.trim();
  if (!line) return undefined;
  return line.length > STATUS_LINE_MAX_CHARS ? `${line.slice(0, STATUS_LINE_MAX_CHARS - 1)}…` : line;
}

/**
 * Read the cache, kicking off a refresh when it is stale. Never blocks.
 * `runner` is injected so tests need no real shell.
 */
export function resolveStatusLineAsync(
  cache: StatusLineCache,
  command: string | undefined,
  now: number,
  runner: (command: string, cb: (raw: string | undefined) => void) => void,
): string | undefined {
  if (!command) return undefined;
  const stale = now - cache.lastRun >= STATUS_LINE_TTL_MS;
  if (stale && !cache.inFlight) {
    cache.inFlight = true;
    cache.lastRun = now;
    runner(command, (raw) => {
      cache.inFlight = false;
      cache.value = raw === undefined ? undefined : firstStatusLine(raw);
    });
  }
  return cache.value;
}

/** Default runner: spawns the command asynchronously with a kill timer. */
export function defaultStatusLineRunner(command: string, cb: (raw: string | undefined) => void): void {
  let settled = false;
  const done = (raw: string | undefined) => {
    if (settled) return;
    settled = true;
    cb(raw);
  };
  try {
    exec(
      command,
      { encoding: "utf8", timeout: STATUS_LINE_TIMEOUT_MS, maxBuffer: 64 * 1024 },
      (err, stdout) => done(err ? undefined : stdout),
    );
  } catch {
    done(undefined);
  }
}

/** Back-compat shim used by older callers/tests: synchronous, no subprocess. */
export function resolveStatusLine(opts?: FooterAlignOptions): string | undefined {
  if (opts?.getStatusLine) return opts.getStatusLine();
  return undefined;
}

export function installFooterRightAlign(mode: object, options?: FooterAlignOptions): void {
  const statusCache = createStatusLineCache();
  const footer = (mode as { footer: { render(w: number): string[] } }).footer;
  const render = footer.render.bind(footer);
  footer.render = (w: number) => {
    const lines = render(w);
    let modeStatusLine = getExecutionModeStatusLine(w);
    const ctxTag = renderContextFooterTag(getLatestContextStats());
    if (ctxTag) {
      const modeLen = visibleLength(modeStatusLine);
      const tagLen = visibleLength(ctxTag);
      const gap = w - modeLen - tagLen;
      if (gap >= 2) {
        modeStatusLine = modeStatusLine + " ".repeat(gap) + ctxTag;
      }
    }

    // Never spawn from render: read the cache and let a background refresh
    // update it (see resolveStatusLineAsync).
    const customStatus = options?.getStatusLine
      ? options.getStatusLine()
      : resolveStatusLineAsync(
          statusCache,
          options?.statusLineCommand,
          Date.now(),
          options?.statusLineRunner ?? defaultStatusLineRunner,
        );
    const extraLines: string[] = [];
    if (customStatus) {
      extraLines.push(truncateToWidth(customStatus, w));
    }

    const withMode = [modeStatusLine, ...extraLines, ...lines];

    // A single-line footer (or none) has no pi status line to align; the mode
    // line is still shown.
    if (withMode.length < 2) return withMode;

    const last = withMode[withMode.length - 1]!;
    const text = last.replace(ANSI, "");
    // Wide glyphs or non-SGR escapes (OSC 8 links) make terminal width
    // unmeasurable here, so leave pi's own line exactly as pi drew it.
    if (!SIMPLE.test(text)) return withMode;
    // Never exceed width: when the line already fills it, pad nothing.
    const pad = Math.max(0, w - visibleLength(last));
    return [...withMode.slice(0, -1), " ".repeat(pad) + last];
  };
}
