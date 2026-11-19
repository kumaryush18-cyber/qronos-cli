import { describe, expect, test } from "bun:test";
import {
  createHeaderExtension,
  DEFAULT_TERMINAL_TITLE,
  headerLines,
  installTerminalTitle,
  LOGO_BLOCKS,
  resolveTerminalTitle,
  TERMINAL_TITLE,
  type ThemeLike,
  type TuiLike,
} from "../src/header";
import { CLI_VERSION } from "../src/version";
import { lightOrangeAnsi } from "../src/shimmer";

/** InlineExtension is a union (bare factory fn | {name, factory}); our
 * factory always returns the object form. */
function asObjectExtension(ext: unknown): { name: string; factory: (pi: unknown) => void } {
  return ext as { name: string; factory: (pi: unknown) => void };
}

/** Fake theme: wraps calls in readable markers instead of real ANSI, so
 * assertions can check nesting/placement without decoding escape codes. */
function fakeTheme(): ThemeLike {
  return {
    fg: (color, text) => `<fg:${color}>${text}</fg>`,
    bold: (text) => `<b>${text}</b>`,
  };
}

/** The collapsed header paints the logo with raw truecolor escapes, so strip
 * real ANSI (not the fake-theme markers) before measuring visible width. */
// eslint-disable-next-line no-control-regex
const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;]*m/g, "");

const MODEL = "DeepSeek V4 Flash";

/** Header colour tests need a real theme object, not the marker fake. */
const theme: ThemeLike = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

describe("headerLines — block-art header", () => {
  const theme = fakeTheme();

  test("collapsed is exactly one line per logo row", () => {
    const lines = headerLines(theme, MODEL, false);
    expect(lines).toHaveLength(LOGO_BLOCKS.length);
  });

  test("every row is indented and carries the logo blocks", () => {
    const lines = headerLines(theme, MODEL, false);
    for (const [i, line] of lines.entries()) {
      expect(line.startsWith(" ")).toBe(true);
      const blocks = (LOGO_BLOCKS[i]!.match(/█/g) ?? []).length;
      expect(stripAnsi(line).split("█").length - 1).toBe(blocks);
    }
  });

  test("names the product and version", () => {
    const lines = headerLines(theme, MODEL, false);
    expect(stripAnsi(lines[1]!)).toContain(`Qronos AI v${CLI_VERSION}`);
  });

  test("shows the gateway label", () => {
    const lines = headerLines(theme, MODEL, false);
    expect(stripAnsi(lines[2]!)).toContain("API Gateway");
  });

  test("shows the working directory", () => {
    const lines = headerLines(theme, MODEL, false, 200);
    expect(stripAnsi(lines[3]!)).toContain(process.cwd());
  });

  test("shows the active model beside a status dot", () => {
    const lines = headerLines(theme, MODEL, false);
    expect(stripAnsi(lines[4]!)).toContain("●");
    expect(stripAnsi(lines[4]!)).toContain(MODEL);
  });

  test("strips a provider prefix from the model name", () => {
    const lines = headerLines(theme, "openai/gpt-4o", false);
    expect(stripAnsi(lines[4]!)).toContain("gpt-4o");
    expect(stripAnsi(lines[4]!)).not.toContain("openai/");
  });

  test("R7: no line contains ad creative markers", () => {
    for (const line of headerLines(theme, MODEL, true)) {
      expect(line).not.toContain("AD ░▒▓");
    }
  });
});

describe("headerLines — expanded (ctrl+o)", () => {
  const theme = fakeTheme();

  test("expanded adds a blank line, the command list, a blank and the hint", () => {
    const collapsed = headerLines(theme, MODEL, false);
    const expanded = headerLines(theme, MODEL, true);
    const commandCount = expanded.filter((l) => l.includes("▸")).length;
    expect(commandCount).toBe(6);
    // 1 blank + commands + 1 blank + 1 hint
    expect(expanded).toHaveLength(collapsed.length + commandCount + 3);
  });

  test("the hint line comes last", () => {
    const expanded = headerLines(theme, MODEL, true);
    expect(expanded.at(-1)).toContain("esc interrupt");
    expect(expanded.at(-1)).toContain("<fg:dim>");
  });

  test("each command line is an accent-padded name plus a dim description", () => {
    const commands = headerLines(theme, MODEL, true).filter((l) => l.includes("▸"));
    for (const line of commands) {
      expect(line).toMatch(/^<fg:accent> {2}▸ \/\S+/);
      expect(line).toContain("<fg:dim>");
    }
  });

  test("command names start at one column", () => {
    const commands = headerLines(theme, MODEL, true).filter((l) => l.includes("▸"));
    const columns = commands.map((l) => l.indexOf("<fg:dim>"));
    expect(new Set(columns).size).toBe(1);
  });

  test("the leading part of a command line carries no description text", () => {
    for (const line of headerLines(theme, MODEL, true).filter((l) => l.includes("▸"))) {
      expect(line.slice(0, line.indexOf("<fg:dim>"))).not.toContain("<fg:dim>");
    }
  });
});

describe("headerLines — width safety", () => {
  const theme = fakeTheme();

  test.each([20, 30, 40, 60, 100])("no line exceeds %i visible columns", (width) => {
    for (const expanded of [false, true]) {
      for (const line of headerLines(theme, MODEL, expanded, width)) {
        expect(stripAnsi(line).length).toBeLessThanOrEqual(width);
      }
    }
  });

  test("a long working directory is truncated rather than wrapped", () => {
    const lines = headerLines(theme, MODEL, false, 40);
    expect(stripAnsi(lines[3]!).length).toBeLessThanOrEqual(40);
  });

  test("survives a pathologically narrow terminal without going negative", () => {
    const lines = headerLines(theme, MODEL, false, 1);
    for (const line of lines) expect(stripAnsi(line).length).toBeLessThanOrEqual(20);
  });
});

describe("terminal title", () => {
  test("default title is the plain app name, no logo glyph", () => {
    expect(DEFAULT_TERMINAL_TITLE).toBe("Qronos CLI");
    expect(resolveTerminalTitle({})).toBe("Qronos CLI");
    expect(resolveTerminalTitle({ QRONOS_TITLE: "   " })).toBe("Qronos CLI");
  });

  test("the default title is pure ASCII, so no font can show a box", () => {
    expect(/^[\x20-\x7e]+$/.test(DEFAULT_TERMINAL_TITLE)).toBe(true);
  });

  test("QRONOS_TITLE overrides the text without a rebuild", () => {
    expect(resolveTerminalTitle({ QRONOS_TITLE: "Qronos" })).toBe("Qronos");
  });

  test("installTerminalTitle writes at once and keeps re-writing it", async () => {
    const titles: string[] = [];
    const stop = installTerminalTitle({ setTitle: (t) => titles.push(t) }, { heartbeatMs: 10 });
    expect(titles).toEqual(["Qronos CLI"]);
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(titles.length).toBeGreaterThan(1);
    stop();
    const after = titles.length;
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(titles.length).toBe(after);
  });

  test("a terminal that refuses the title write cannot break the session", () => {
    const stop = installTerminalTitle(
      {
        setTitle: () => {
          throw new Error("no title support");
        },
      },
      { heartbeatMs: 0 },
    );
    stop();
    expect(true).toBe(true);
  });
});

describe("createHeaderExtension (registration)", () => {
  function stubPi() {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    return {
      on: (name: string, handler: (event: unknown, ctx: unknown) => void) => {
        handlers.set(name, handler);
      },
      handlers,
    };
  }

  function stubUi() {
    let factory: ((tui: TuiLike, theme: ThemeLike) => unknown) | undefined;
    let calls = 0;
    const titles: string[] = [];
    return {
      setHeader: (f: (tui: TuiLike, theme: ThemeLike) => unknown) => {
        factory = f;
        calls++;
      },
      setTitle: (title: string) => {
        titles.push(title);
      },
      get titles() {
        return titles;
      },
      get factory() {
        return factory;
      },
      get calls() {
        return calls;
      },
    };
  }

  test("registers session_start and session_shutdown only", () => {
    const pi = stubPi();
    // shimmerFrameMs: 0 keeps the repaint timer out of the assertion below
    asObjectExtension(createHeaderExtension({ modelName: MODEL, shimmerFrameMs: 0 })).factory(
      pi as never,
    );
    expect([...pi.handlers.keys()]).toEqual(["session_start", "session_shutdown"]);
  });

  test("session_start calls setHeader exactly once; render(100) matches headerLines", () => {
    const pi = stubPi();
    // shimmerFrameMs: 0 keeps the repaint timer out of the assertion below
    asObjectExtension(createHeaderExtension({ modelName: MODEL, shimmerFrameMs: 0 })).factory(
      pi as never,
    );
    const ui = stubUi();
    let requestRenderCalls = 0;
    const tui: TuiLike = { requestRender: () => requestRenderCalls++ };

    pi.handlers.get("session_start")!({}, { ui });
    expect(ui.calls).toBe(1);
    // The terminal tab title is plain text; it must not say "node", and it
    // carries the small Q badge in front of the name.
    expect(ui.titles[0]).toBe(resolveTerminalTitle());
    expect(TERMINAL_TITLE).toBe("Qronos CLI");
    pi.handlers.get("session_shutdown")!({}, { ui });

    const component = ui.factory!(tui, fakeTheme()) as {
      render(width: number): string[];
      invalidate(): void;
      setExpanded(v: boolean): void;
    };
    // Compare the visible text: the shimmer colour depends on the clock.
    expect(component.render(100).map(stripAnsi)).toEqual(
      headerLines(fakeTheme(), MODEL, false).map(stripAnsi),
    );

    component.setExpanded(true);
    expect(requestRenderCalls).toBe(1);
    expect(component.render(100).map(stripAnsi)).toEqual(
      headerLines(fakeTheme(), MODEL, true).map(stripAnsi),
    );

    component.setExpanded(false);
    expect(requestRenderCalls).toBe(2);
    // Compare the visible text: the shimmer colour depends on the clock.
    expect(component.render(100).map(stripAnsi)).toEqual(
      headerLines(fakeTheme(), MODEL, false).map(stripAnsi),
    );

    // invalidate is a no-op that doesn't throw
    expect(() => component.invalidate()).not.toThrow();
  });
});

describe("update banner (replaces pi's own suppressed `pi update` banner)", () => {
  const theme = fakeTheme();

  test("no banner when no newer version was reported", () => {
    const lines = headerLines(theme, MODEL, false, 100);
    expect(lines.some((l) => l.includes("Update Available"))).toBe(false);
  });

  test("banner appears, names the version, and points at /update (never `pi update`)", () => {
    const text = headerLines(theme, MODEL, false, 100, "0.2.19").join("\n");
    expect(text).toContain("Update Available");
    expect(text).toContain("New version 0.2.19 is available. Run /update");
    expect(text).not.toContain("pi update");
    expect(text).not.toContain("npx qronos-cli@latest");
  });

  test("banner is bordered above and below in the warning color", () => {
    const borders = headerLines(theme, MODEL, false, 100, "0.2.19").filter((l) =>
      l.includes("<fg:warning>─"),
    );
    expect(borders).toHaveLength(2);
  });

  test("banner renders last, after the collapsed header body", () => {
    // Same `now` for both calls: the shimmer moves with the clock, so two calls
    // at different times would differ in colour even with identical content.
    const at = 1_000;
    const withBanner = headerLines(theme, MODEL, false, 100, "0.2.19", at);
    const without = headerLines(theme, MODEL, false, 100, undefined, at);
    expect(withBanner.slice(0, without.length)).toEqual(without);
    expect(withBanner.length).toBeGreaterThan(without.length);
  });

  test("does not overflow a narrow terminal", () => {
    for (const line of headerLines(theme, MODEL, false, 30, "0.2.19")) {
      expect(stripAnsi(line).replace(/<\/?(b|fg:[a-z]+)>/g, "").length).toBeLessThanOrEqual(30);
    }
  });
});

describe("brand line: orange name, pale version, moving glow", () => {
  const nameLine = (now = 0) => headerLines(theme, MODEL, false, 100, undefined, now)[1]!;

  test("'Qronos AI' is orange and the version is the pale orange", () => {
    const line = nameLine(0);
    expect(stripAnsi(line)).toContain(`Qronos AI v${CLI_VERSION}`);
    // the version carries the light orange, the name starts plain brand orange
    expect(line).toContain(`${lightOrangeAnsi()}v${CLI_VERSION}`);
  });

  test("a light band flows through the name as the clock moves", () => {
    const phases = [0, 500, 1000, 1500, 2000, 2500].map((ms) => nameLine(ms));
    // each moment paints the name differently: that is the glow moving
    expect(new Set(phases).size).toBe(phases.length);
  });

  test("at the top of the sweep the name itself glows pale", () => {
    // span = "Qronos AI".length + band; pick the phase that centres the band on
    // the "n" of Qronos so the escape is exactly the pale orange.
    const span = "Qronos AI".length + 4;
    const peak = ((4 + 4) / span) * 3000;
    const line = nameLine(peak % 3000);
    const namePart = line.slice(0, line.indexOf(lightOrangeAnsi() + "v"));
    expect(namePart).toContain(lightOrangeAnsi());
  });

  test("the glow does not change the visible text or the width", () => {
    for (const line of headerLines(theme, MODEL, false, 100, undefined, 1234)) {
      expect(stripAnsi(line).replace(/<\/?(b|fg:[a-z]+)>/g, "").length).toBeLessThanOrEqual(100);
    }
  });
});

describe("shimmer repaint timer", () => {
  test("asks the TUI to repaint while the header is alive, and stops on dispose", async () => {
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) };
    asObjectExtension(createHeaderExtension({ modelName: MODEL, shimmerFrameMs: 5 })).factory(
      pi as never,
    );
    let factory: ((tui: TuiLike, theme: ThemeLike) => unknown) | undefined;
    const ui = {
      setHeader: (f: (tui: TuiLike, theme: ThemeLike) => unknown) => {
        factory = f;
      },
      setTitle: () => {},
    };
    let renders = 0;
    const tui: TuiLike = { requestRender: () => renders++ };
    handlers.get("session_start")!({}, { ui });
    const component = factory!(tui, fakeTheme()) as { dispose?: () => void };

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(renders).toBeGreaterThan(1);

    component.dispose?.();
    const afterDispose = renders;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(renders).toBe(afterDispose);
  });
});

describe("brand line size", () => {
  test("the name and the version are bold, so the line looks larger", () => {
    const line = headerLines(theme, MODEL, false, 100, undefined, 0)[1]!;
    expect(line).toContain("\x1b[1m");
    // bold is re-applied after every shimmered character, not just once
    expect((line.match(/\x1b\[1m/g) ?? []).length).toBeGreaterThan("Qronos AI".length - 1);
    expect(line).toContain(`\x1b[1m${lightOrangeAnsi()}v${CLI_VERSION}`);
  });

  test("bold does not change the visible text or the width", () => {
    const line = headerLines(theme, MODEL, false, 100, undefined, 500)[1]!;
    expect(stripAnsi(line).replace(/<\/?(b|fg:[a-z]+)>/g, "")).toContain(`Qronos AI v${CLI_VERSION}`);
  });
});
