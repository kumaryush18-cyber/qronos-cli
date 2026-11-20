// The ad widget, made clickable.
//
// Why this file exists: an ad drawn with OSC 8 links only opens when the
// *terminal* decides to open it. In pi's fullscreen mode the app captures the
// mouse (pi-tui sends `?1000h ?1002h ?1006h`), so the terminal never sees the
// click and cannot open anything; pi opens the link itself only for a plain
// left click it sees on the OSC 8 span. Ctrl+click, Cmd+click and terminals
// without OSC 8 support (GNOME Terminal, old Windows Terminal) therefore did
// nothing.
//
// So the widget handles the mouse itself: any left press opens the ad with the
// same opener the rest of Qronos uses (src/browser.ts). OSC 8 stays on every
// line as a second path, because in regular (non-fullscreen) mode no mouse
// tracking is on and the terminal owns the click — there Ctrl+click and
// Cmd+click work natively.
import type { AdCreative } from "@qronos/shared";
import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { openBrowser, safeBrowserUrl } from "../../browser";
import { adLines, type ThemeLike } from "./style";

/** A press is followed by a click event on the same pixel; this stops a double open. */
export const OPEN_DEBOUNCE_MS = 800;

export interface AdWidgetOptions {
  /** Injected in tests; defaults to the real platform opener. */
  open?: (url: string) => void;
  /** Injected in tests; defaults to Date.now. */
  now?: () => number;
}

export type BrowserOpener = (url: string) => void;

/**
 * Open an ad URL in the browser, or do nothing when the URL is not http(s).
 * `safeBrowserUrl` is the same guard the login flow uses: an ad's click_url is
 * server-supplied, so it must never reach a shell or a file:// handler.
 */
export function openAdUrl(url: string, opener: BrowserOpener = openBrowser): boolean {
  const safe = safeBrowserUrl(url);
  if (safe === null) return false;
  try {
    opener(safe);
    return true;
  } catch {
    // Best-effort: a machine with no browser must not break the session.
    return false;
  }
}

/**
 * Ad widget: renders the card at the live width and opens the click URL on a
 * left press. Nothing other than a left button is consumed, so right-click
 * paste and wheel scrolling keep working over the ad.
 */
export class AdWidget implements Component {
  private lastOpenAt = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly creative: AdCreative,
    private readonly clickUrl: string,
    private readonly adMinColumns: number,
    private readonly getTheme: () => ThemeLike,
    private readonly options: AdWidgetOptions = {},
  ) {}

  render(width: number): string[] {
    return adLines(this.creative, this.clickUrl, this.getTheme(), width, this.adMinColumns).map(
      (line) => ` ${line}`,
    );
  }

  invalidate(): void {
    // Every render reads the live theme and width, so there is nothing cached.
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    // "press" fires at once (feels instant). Some terminals also send "click"
    // on release; the debounce keeps that from opening two browser tabs.
    if (event.type !== "press" && event.type !== "click") return undefined;
    if (event.button !== "left") return undefined;
    this.open();
    return { handled: true };
  }

  /** Open once per OPEN_DEBOUNCE_MS. Returns whether the opener ran this time. */
  open(): boolean {
    const now = (this.options.now ?? Date.now)();
    if (now - this.lastOpenAt < OPEN_DEBOUNCE_MS) return false;
    this.lastOpenAt = now;
    return openAdUrl(this.clickUrl, this.options.open);
  }
}

/**
 * pi widget factory for an ad. pi calls `render(width)` with the live terminal
 * width on every paint, so the card (or the below-`adMinColumns` plain line)
 * is re-laid-out after a resize instead of keeping the width it had at fetch
 * time.
 */
export function adWidget(
  creative: AdCreative,
  clickUrl: string,
  adMinColumns: number,
  options?: AdWidgetOptions,
) {
  return (_tui: unknown, theme: ThemeLike) =>
    new AdWidget(creative, clickUrl, adMinColumns, () => theme, options);
}
