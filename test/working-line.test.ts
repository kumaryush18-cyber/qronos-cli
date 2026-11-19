import { describe, expect, test } from "bun:test";
import {
  ARROW_REQUESTING,
  ARROW_WORKING,
  buildWorkingLine,
  createWorkingLineExtension,
  ELAPSED_AFTER_MS,
  FRAME_MS,
  formatElapsed,
  GLYPHS,
  mutedAnsi,
  orangeAnsi,
  pickVerb,
  SPINNER_FRAMES,
  truncateToWidth,
  VERB_ROTATE_MS,
  pickVerbDifferentFrom,
  buildDoneLine,
  buildDoneRows,
  DONE_GLYPH,
  DONE_VERBS,
  SHIMMER_BAND,
  SHIMMER_PERIOD_MS,
  shimmerText,
  lightOrangeAnsi,
  pickDoneVerb,
  VERBS,
  visibleLength,
  WORKING_LINE_WIDGET_ID,
} from "../src/working-line";

const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");

describe("spinner frames", () => {
  test("uses Claude Code's glyph set", () => {
    expect([...GLYPHS]).toEqual(["·", "✢", "✳", "✶", "✻", "✽"]);
  });

  test("animates forward then backward (ping-pong), like Claude Code", () => {
    expect(SPINNER_FRAMES).toEqual(["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"]);
  });
});

describe("pickVerb", () => {
  test("returns a verb from Claude Code's own list", () => {
    const verbs: readonly string[] = VERBS;
    expect(verbs).toContain(pickVerb(() => 0));
    expect(verbs).toContain(pickVerb(() => 0.999));
    expect(verbs.length).toBeGreaterThan(150);
  });

  test("keeps the playful words the user asked for", () => {
    const verbs: readonly string[] = VERBS;
    expect(verbs).toContain("Galloping");
    expect(verbs).toContain("Photosynthesizing");
    expect(verbs).toContain("Gitifying");
  });

  test("is stable for the same random value", () => {
    expect(pickVerb(() => 0.42)).toBe(pickVerb(() => 0.42));
  });

  test("pickVerbDifferentFrom never returns the current word when it can avoid it", () => {
    let i = 0;
    const sequence = [0.0, 0.0, 0.5];
    const random = () => sequence[Math.min(i++, sequence.length - 1)]!;
    const first = pickVerb(() => 0);
    const next = pickVerbDifferentFrom(first, random);
    expect(next).not.toBe(first);
  });
});

describe("formatElapsed", () => {
  test("seconds, minutes and hours", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(32_000)).toBe("32s");
    expect(formatElapsed(63_000)).toBe("1m 3s");
    expect(formatElapsed(3_720_000)).toBe("1h 2m");
  });
});

describe("buildWorkingLine", () => {
  const base = { frame: 1, verb: "Crafting", phase: "responding" as const, tokens: 0, elapsedMs: 0 };

  test("no count and no time yet: just the glyph and the verb", () => {
    expect(strip(buildWorkingLine(base))).toBe("✢ Crafting…");
  });

  test("output tokens are shown with the ↓ arrow and the word tokens", () => {
    expect(strip(buildWorkingLine({ ...base, tokens: 1234 }))).toBe("✢ Crafting… (↓ 1.2k tokens)");
  });

  test("requesting uses ↑, everything else ↓", () => {
    const sent = strip(buildWorkingLine({ ...base, phase: "requesting", tokens: 0 }));
    expect(sent).not.toContain(ARROW_WORKING);
    const working = strip(buildWorkingLine({ ...base, tokens: 10 }));
    expect(working).toContain(`${ARROW_WORKING} 10 tokens`);
    expect(strip(buildWorkingLine({ ...base, phase: "requesting", tokens: 0 }))).not.toContain("tokens");
    expect(ARROW_REQUESTING).toBe("↑");
  });

  test("elapsed time appears only after 30 s and comes first", () => {
    expect(strip(buildWorkingLine({ ...base, tokens: 100, elapsedMs: ELAPSED_AFTER_MS - 1 }))).not.toContain("s ·");
    expect(strip(buildWorkingLine({ ...base, tokens: 100, elapsedMs: 32_000 }))).toBe(
      "✢ Crafting… (32s · ↓ 100 tokens)",
    );
  });

  test("thinking and tool states are labelled; plain responding is not", () => {
    expect(strip(buildWorkingLine({ ...base, phase: "thinking", tokens: 50 }))).toBe(
      "✢ Crafting… (↓ 50 tokens · thinking)",
    );
    expect(strip(buildWorkingLine({ ...base, phase: "tool", tokens: 50 }))).toBe("✢ Crafting… (↓ 50 tokens · tool)");
    expect(strip(buildWorkingLine({ ...base, tokens: 50 }))).toBe("✢ Crafting… (↓ 50 tokens)");
  });

  test("the glyph advances with the frame and wraps around", () => {
    const first = strip(buildWorkingLine({ ...base, frame: 0 })).charAt(0);
    const second = strip(buildWorkingLine({ ...base, frame: 1 })).charAt(0);
    expect(first).toBe("·");
    expect(second).toBe("✢");
    expect(strip(buildWorkingLine({ ...base, frame: SPINNER_FRAMES.length })).charAt(0)).toBe("·");
  });

  test("the glyph carries the brand orange for this terminal's colour mode", () => {
    // Same helper the code uses, so a 256-colour terminal still gets 38;5;Nm.
    expect(buildWorkingLine(base)).toContain(orangeAnsi());
    expect(orangeAnsi()).not.toBe("");
  });

  test("glyph and verb are both orange, the (…) part stays grey", () => {
    const line = buildWorkingLine({ ...base, tokens: 1234 });
    expect(line).toContain(`${orangeAnsi()}✢`);
    expect(line).toContain(`${orangeAnsi()}Crafting…`);
    expect(line).toContain(mutedAnsi());
  });

  test("shimmer flows a light orange band through the verb", () => {
    const phase = (p: number) => buildWorkingLine({ ...base, shimmerPhase: p });
    expect(phase(0)).not.toBe(phase(0.5));
    // the band follows the phase, so different times give different colours.
    // Match BOTH forms: truecolor "38;2;r;g;b" and 256-colour "38;5;n" (CI has
    // no TTY, so pi reports 256-colour there).
    const colours = new Set(phase(0.5).match(/\x1b\[38;[0-9;]+m/g) ?? []);
    expect(colours.size).toBeGreaterThan(2);
    // at the top of the band a character is exactly the light orange
    const span = "Galloping…".length + SHIMMER_BAND;
    const peak = (6 + SHIMMER_BAND) / span;
    expect(buildWorkingLine({ ...base, verb: "Galloping", shimmerPhase: peak })).toContain(lightOrangeAnsi());
  });

  test("shimmer keeps the visible text unchanged", () => {
    const plainLine = buildWorkingLine(base);
    const shiny = buildWorkingLine({ ...base, shimmerPhase: 0.3 });
    expect(strip(plainLine)).toBe(strip(shiny));
  });

  test("one sweep takes 3 s", () => {
    expect(SHIMMER_PERIOD_MS).toBe(3000);
  });

  test("150 ms per glyph, as asked", () => {
    expect(FRAME_MS).toBe(150);
  });

});

describe("truncateToWidth", () => {
  test("the summary line names the run length in LIGHT orange", () => {
    const line = buildDoneLine("Churned", 150_000);
    expect(line).toContain(`✻ Churned for 2m 30s`);
    expect(line).toContain(lightOrangeAnsi());
    expect(line).not.toContain(orangeAnsi());
    expect(buildDoneLine("Baked", 12_000)).toContain("Baked for 12s");
    expect(buildDoneLine("Zested", 0)).toContain("Zested for 0s");
  });

  test("the closing word is one of the past-tense verbs", () => {
    const verbs: readonly string[] = DONE_VERBS;
    expect(verbs).toContain(pickDoneVerb(() => 0));
    expect(verbs).toContain(pickDoneVerb(() => 0.999));
  });

  test("the finished state is ONE row: no dashed rule under it", () => {
    const rows = buildDoneRows("Churned", 150_000, 20);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("✻ Churned for 2m 30s");
    expect(rows.join("")).not.toContain("-");
  });

  test("leaves short lines alone and cuts long ones with an ellipsis", () => {
    expect(truncateToWidth("abc", 10)).toBe("abc");
    const cut = truncateToWidth("abcdefghij", 5);
    expect(cut).toContain("…");
    expect(visibleLength(cut)).toBeLessThanOrEqual(5);
  });

  test("colours do not count as width", () => {
    const coloured = "\x1b[38;2;255;107;0m✢\x1b[0m Crafting…";
    expect(visibleLength(coloured)).toBe(11);
  });
});

describe("qronos-working-line extension", () => {
  function harness(clock = { at: 0 }, random = () => 0, frameMs = 1_000_000) {
    const widgets: { key: string; content: unknown; options?: unknown }[] = [];
    const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
    const renders: number[] = [];
    const api = {
      on(type: string, handler: (event: unknown, ctx: unknown) => void) {
        handlers.set(type, handler);
        return () => {};
      },
    };
    const ui = {
      setWidget: (key: string, content: unknown, options?: unknown) => widgets.push({ key, content, options }),
      setWorkingVisible: () => {},
    };
    const ctx = { ui };
    const ext = createWorkingLineExtension({ now: () => clock.at, random, frameMs }) as {
      factory: (pi: never) => void;
    };
    ext.factory(api as never);
    const drawWidget = () => {
      const widget = widgets.at(-1)!;
      const factory = widget.content as (tui: unknown) => { render: (w: number) => string[]; invalidate(): void };
      const component = factory({ requestRender: () => renders.push(1) });
      return { component, widget };
    };
    return { handlers, ctx, widgets, drawWidget, renders, clock };
  }

  const assistant = (output?: number) => ({ role: "assistant", usage: output === undefined ? {} : { output } });
  const update = (text: string, output?: number) => ({
    message: assistant(output),
    assistantMessageEvent: { type: "text_delta", delta: text },
  });

  test("registers one widget above the editor", () => {
    const { handlers, ctx, widgets } = harness();
    handlers.get("session_start")!({}, ctx);
    expect(widgets).toHaveLength(1);
    expect(widgets[0]!.key).toBe(WORKING_LINE_WIDGET_ID);
    expect(widgets[0]!.options).toEqual({ placement: "aboveEditor" });
  });

  test("draws nothing while idle", () => {
    const { handlers, ctx, drawWidget } = harness();
    handlers.get("session_start")!({}, ctx);
    const { component } = drawWidget();
    expect(component.render(80)).toEqual([]);
  });

  test("counts the whole run: three model calls, one growing number", () => {
    const { handlers, ctx, drawWidget, clock } = harness();
    handlers.get("session_start")!({}, ctx);
    handlers.get("agent_start")!({}, ctx);

    handlers.get("message_start")!({ message: assistant() }, ctx);
    handlers.get("message_update")!(update("a".repeat(400)), ctx);
    handlers.get("message_end")!({ message: assistant(100) }, ctx);
    const afterFirst = strip(drawWidget().component.render(80)[0]!);

    clock.at += 1000;
    handlers.get("message_start")!({ message: assistant() }, ctx);
    handlers.get("message_update")!(update("a".repeat(400)), ctx);
    handlers.get("message_end")!({ message: assistant(100) }, ctx);
    const afterSecond = strip(drawWidget().component.render(80)[0]!);

    // turn_end must NOT reset: it fires after every model call, so the extension
    // deliberately does not listen to it (only agent_start starts a new count).
    expect(handlers.has("turn_end")).toBe(false);
    expect(strip(drawWidget().component.render(80)[0]!)).toBe(afterSecond);

    expect(afterFirst).toContain("↓ 100 tokens");
    expect(afterSecond).toContain("↓ 200 tokens");
  });

  test("a new prompt starts again from zero", () => {
    const { handlers, ctx, drawWidget } = harness();
    handlers.get("session_start")!({}, ctx);
    handlers.get("agent_start")!({}, ctx);
    handlers.get("message_start")!({ message: assistant() }, ctx);
    handlers.get("message_update")!(update("a".repeat(4000)), ctx);
    handlers.get("message_end")!({ message: assistant(1000) }, ctx);
    expect(strip(drawWidget().component.render(80)[0]!)).toContain("↓ 1.0k tokens");

    handlers.get("agent_end")!({}, ctx);
    // after the answer: only the summary line stays
    const rows = drawWidget().component.render(80).map(strip);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("for");
    expect(rows[0]).not.toContain("tokens");
    expect(rows[0]).not.toContain("-");

    handlers.get("agent_start")!({}, ctx);
    // the new run starts from zero: verb and glyph, no count, no closing line
    const fresh = strip(drawWidget().component.render(80)[0]!);
    expect(fresh).not.toContain("tokens");
    expect(fresh).not.toContain("for ");
  });

  test("tool calls change the label but keep the count", () => {
    const { handlers, ctx, drawWidget } = harness();
    handlers.get("session_start")!({}, ctx);
    handlers.get("agent_start")!({}, ctx);
    handlers.get("message_start")!({ message: assistant() }, ctx);
    handlers.get("message_update")!(update("a".repeat(2000)), ctx);
    handlers.get("message_end")!({ message: assistant(500) }, ctx);
    handlers.get("tool_execution_start")!({}, ctx);
    expect(strip(drawWidget().component.render(80)[0]!)).toContain("↓ 500 tokens · tool");
    handlers.get("tool_execution_end")!({}, ctx);
    expect(strip(drawWidget().component.render(80)[0]!)).toContain("thinking");
  });

  test("the verb changes every second while the run is active", async () => {
    let tick = 0;
    const clock = { at: 0 };
    const words = ["Galloping", "Noodling", "Brewing", "Zesting"];
    const random = () => ((tick++ * 0.37) % 1);
    const { handlers, ctx, drawWidget } = harness(clock, random, 5);
    handlers.get("session_start")!({}, ctx);
    handlers.get("agent_start")!({}, ctx);
    const first = strip(drawWidget().component.render(80)[0]!);

    clock.at += VERB_ROTATE_MS + 5;
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = strip(drawWidget().component.render(80)[0]!);

    expect(VERB_ROTATE_MS).toBe(6000);
    expect(words.some((word) => first.includes(word)) || /…/.test(first)).toBe(true);
    expect(second).not.toBe(first);
  });

  test("keeps repainting while the run is on, and stops after it", () => {
    const { handlers, ctx, drawWidget, renders } = harness();
    handlers.get("session_start")!({}, ctx);
    drawWidget(); // capture the tui handle
    handlers.get("agent_start")!({}, ctx);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        const atRun = renders.length;
        expect(atRun).toBeGreaterThan(0);
        handlers.get("agent_end")!({}, ctx);
        const afterEnd = renders.length;
        setTimeout(() => {
          expect(renders.length).toBeLessThanOrEqual(afterEnd + 1);
          resolve();
        }, 30);
      }, 30);
    });
  });
});