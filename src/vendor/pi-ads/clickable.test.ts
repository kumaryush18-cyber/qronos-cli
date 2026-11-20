// Click behaviour of the ad widget.
//
// The bug this covers: with OSC 8 links alone, ctrl+click and cmd+click did
// nothing. In fullscreen mode pi captures the mouse, so the terminal cannot
// open the link; and terminals without OSC 8 support never open it at all.
// The widget now opens the ad itself on any left press.
import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { AdCreative } from "@qronos/shared";
import { AdWidget, adWidget, openAdUrl, OPEN_DEBOUNCE_MS } from "./clickable";

const theme = { fg: (_c: string, _t: string) => _t, bold: (_t: string) => _t };
const URL_ = "https://qronos.me/c/tok-1";
const creative: AdCreative = {
  headline: "Headline",
  body: "Body copy",
  cta: "Click here",
  accent: "#fff",
};

function mouse(overrides: Record<string, unknown> = {}) {
  return {
    type: "press",
    button: "left",
    x: 10,
    y: 1,
    screenX: 11,
    screenY: 20,
    width: 60,
    height: 5,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  } as never;
}

function makeWidget(options: { open?: (url: string) => void; now?: () => number } = {}) {
  const opened: string[] = [];
  let clock = 1_000;
  const widget = new AdWidget(creative, URL_, 60, () => theme, {
    open: options.open ?? ((url) => opened.push(url)),
    now: options.now ?? (() => clock),
  });
  return { widget, opened, tick: (ms: number) => (clock += ms) };
}

describe("ad click: any left press opens the ad", () => {
  test("a plain left press opens the click URL and is consumed", () => {
    const { widget, opened } = makeWidget();
    expect(widget.handleMouse(mouse())).toEqual({ handled: true });
    expect(opened).toEqual([URL_]);
  });

  test("ctrl+click opens the ad (the reported bug)", () => {
    const { widget, opened } = makeWidget();
    widget.handleMouse(mouse({ ctrl: true }));
    expect(opened).toEqual([URL_]);
  });

  test("a cmd+click arrives without modifiers we can see, but still opens", () => {
    // macOS terminals do not report Super/Cmd; the press looks like a plain
    // left press. It must open, not be ignored.
    const { widget, opened } = makeWidget();
    widget.handleMouse(mouse({ ctrl: false, shift: false, alt: false }));
    expect(opened).toEqual([URL_]);
  });

  test("shift+click and alt+click open too", () => {
    const opened: string[] = [];
    const widget = new AdWidget(creative, URL_, 60, () => theme, { open: (u) => opened.push(u) });
    widget.handleMouse(mouse({ shift: true }));
    expect(opened).toHaveLength(1);
  });

  test("press then release-click opens exactly one tab", () => {
    const { widget, opened } = makeWidget();
    widget.handleMouse(mouse({ type: "press" }));
    widget.handleMouse(mouse({ type: "click" }));
    expect(opened).toEqual([URL_]);
  });

  test("a second press after the debounce opens again", () => {
    const { widget, opened, tick } = makeWidget();
    widget.handleMouse(mouse());
    tick(OPEN_DEBOUNCE_MS + 1);
    widget.handleMouse(mouse());
    expect(opened).toEqual([URL_, URL_]);
  });

  test("right-click is left alone so paste keeps working", () => {
    const { widget, opened } = makeWidget();
    expect(widget.handleMouse(mouse({ button: "right" }))).toBeUndefined();
    expect(opened).toEqual([]);
  });

  test("middle-click is left alone", () => {
    const { widget, opened } = makeWidget();
    expect(widget.handleMouse(mouse({ button: "middle" }))).toBeUndefined();
    expect(opened).toEqual([]);
  });

  test("wheel, move and drag events are not consumed", () => {
    const { widget, opened } = makeWidget();
    for (const type of ["wheel", "move", "drag", "release"]) {
      expect(widget.handleMouse(mouse({ type }))).toBeUndefined();
    }
    expect(opened).toEqual([]);
  });
});

describe("openAdUrl: only http(s) reaches the browser", () => {
  test("an https URL opens", () => {
    const opened: string[] = [];
    expect(openAdUrl(URL_, (u) => opened.push(u))).toBe(true);
    expect(opened).toEqual([URL_]);
  });

  test("a file:// URL is refused", () => {
    const opened: string[] = [];
    expect(openAdUrl("file:///etc/passwd", (u) => opened.push(u))).toBe(false);
    expect(opened).toEqual([]);
  });

  test("a javascript: URL is refused", () => {
    const opened: string[] = [];
    expect(openAdUrl("javascript:alert(1)", (u) => opened.push(u))).toBe(false);
    expect(opened).toEqual([]);
  });

  test("an empty URL is refused", () => {
    expect(openAdUrl("", () => {})).toBe(false);
  });

  test("a throwing opener does not escape", () => {
    expect(
      openAdUrl(URL_, () => {
        throw new Error("no browser here");
      }),
    ).toBe(false);
  });
});

describe("ad widget still renders and stays clickable together", () => {
  test("every rendered line carries the OSC 8 link (regular mode fallback)", () => {
    const widget = adWidget(creative, URL_, 60)(undefined, theme);
    const lines = widget.render(60);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    // The card uses a shared link id so the whole card is one hover group.
    for (const line of lines) expect(line).toMatch(new RegExp(`\\x1b\\]8;(?:id=[0-9a-f]+;)?${URL_}`));
  });

  test("rendered lines fit the width in terminal cells", () => {
    const widget = adWidget(creative, URL_, 60)(undefined, theme);
    for (const width of [80, 60, 44, 30, 12]) {
      for (const line of widget.render(width)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
    }
  });

  test("the widget exposes dispose-free handleMouse and invalidate", () => {
    const widget = adWidget(creative, URL_, 60)(undefined, theme);
    expect(typeof widget.handleMouse).toBe("function");
    expect(() => widget.invalidate()).not.toThrow();
  });
});
