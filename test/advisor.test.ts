// Tests for the advisor: the env switch, the cadence, and the parsing of what
// the reviewer sends back. Parsing is where a second model usually goes wrong
// (JSON with a fence, bullets, or a chatty "looks good"), so it is covered
// heavily. The event wiring is exercised through the real extension factory with
// an injected fake model call.
import { describe, expect, test } from "bun:test";
import {
  advisorStatus,
  buildReviewPrompt,
  formatAdvisorSection,
  parseAdvisorAdvice,
  parseAdvisorConfig,
  shouldReview,
  type AdvisorConfig,
} from "../src/advisor-core";
import { createAdvisorExtension, textOf, withTimeout } from "../src/advisor";

const ON: AdvisorConfig = { enabled: true, everyTurns: 1, maxNotes: 4 };

describe("parseAdvisorConfig", () => {
  test("disabled by default and for explicit off values", () => {
    expect(parseAdvisorConfig({}).enabled).toBe(false);
    for (const value of ["off", "0", "false", "no"]) {
      expect(parseAdvisorConfig({ QRONOS_ADVISOR: value }).enabled).toBe(false);
    }
  });

  test("a model id switches it on with that model", () => {
    const config = parseAdvisorConfig({ QRONOS_ADVISOR: "deepseek-v4-flash" });
    expect(config.enabled).toBe(true);
    expect(config.model).toBe("deepseek-v4-flash");
  });

  test("QRONOS_ADVISOR_MODEL wins over the switch value", () => {
    const config = parseAdvisorConfig({ QRONOS_ADVISOR: "1", QRONOS_ADVISOR_MODEL: " glm-4.6 " });
    expect(config.model).toBe("glm-4.6");
  });

  test("cadence and note caps are clamped", () => {
    expect(parseAdvisorConfig({ QRONOS_ADVISOR: "1", QRONOS_ADVISOR_EVERY: "3" }).everyTurns).toBe(3);
    expect(parseAdvisorConfig({ QRONOS_ADVISOR: "1", QRONOS_ADVISOR_EVERY: "0" }).everyTurns).toBe(1);
    expect(parseAdvisorConfig({ QRONOS_ADVISOR: "1", QRONOS_ADVISOR_EVERY: "9999" }).everyTurns).toBe(50);
    expect(parseAdvisorConfig({ QRONOS_ADVISOR: "1", QRONOS_ADVISOR_MAX_NOTES: "99" }).maxNotes).toBe(8);
  });
});

describe("shouldReview", () => {
  test("every turn when everyTurns is 1", () => {
    expect(shouldReview(1, ON)).toBe(true);
    expect(shouldReview(2, ON)).toBe(true);
  });

  test("every Nth turn when configured", () => {
    const config = { ...ON, everyTurns: 3 };
    expect(shouldReview(1, config)).toBe(false);
    expect(shouldReview(3, config)).toBe(true);
    expect(shouldReview(6, config)).toBe(true);
  });

  test("never when disabled, and never for turn 0", () => {
    expect(shouldReview(4, { ...ON, enabled: false })).toBe(false);
    expect(shouldReview(0, ON)).toBe(false);
  });
});

describe("parseAdvisorAdvice", () => {
  test("NO_ISSUES means silence", () => {
    expect(parseAdvisorAdvice("NO_ISSUES")).toEqual({ notes: [] });
    expect(parseAdvisorAdvice("  no_issues  ")).toEqual({ notes: [] });
    expect(parseAdvisorAdvice("")).toEqual({ notes: [] });
  });

  test("reads JSON, including a fenced block", () => {
    const advice = parseAdvisorAdvice(
      '```json\n{"blocker":"","notes":["catch hides ENOENT","no test for the retry path"]}\n```',
    );
    expect(advice.blocker).toBeUndefined();
    expect(advice.notes).toEqual(["catch hides ENOENT", "no test for the retry path"]);
  });

  test("reads a blocker", () => {
    const advice = parseAdvisorAdvice('{"blocker":"loadUser is never exported","notes":[]}');
    expect(advice.blocker).toBe("loadUser is never exported");
  });

  test("falls back to bullets when the model ignores the JSON request", () => {
    const advice = parseAdvisorAdvice("- the catch now hides network errors\n- add a retry test");
    expect(advice.notes).toEqual(["the catch now hides network errors", "add a retry test"]);
  });

  test("drops empty-praise lines and honours maxNotes", () => {
    const advice = parseAdvisorAdvice(
      "- looks good\n- LGTM.\n- one real issue here\n- another real issue\n- third real issue",
      2,
    );
    expect(advice.notes).toEqual(["one real issue here", "another real issue"]);
  });

  test("never injects a raw prose blob as one giant note", () => {
    const advice = parseAdvisorAdvice("I reviewed the change and it seems mostly fine overall.");
    // One line, long enough to be meaningful: allowed, but only as a single note.
    expect(advice.notes.length).toBeLessThanOrEqual(1);
  });
});

describe("formatAdvisorSection", () => {
  test("blocker first, notes after, always tagged", () => {
    const section = formatAdvisorSection({ blocker: "wrong import", notes: ["add a test"] })!;
    expect(section).toContain("<advisor-notes>");
    expect(section.indexOf("BLOCKER")).toBeLessThan(section.indexOf("- add a test"));
    expect(section).toContain("</advisor-notes>");
  });

  test("nothing to say means no section at all", () => {
    expect(formatAdvisorSection({ notes: [] })).toBeUndefined();
  });
});

describe("buildReviewPrompt", () => {
  test("includes the request, tools and the turn, and clips huge turns", () => {
    const prompt = buildReviewPrompt({
      userText: "rename fetchUser",
      toolsUsed: ["edit", "bash"],
      assistantText: "x".repeat(9000),
    });
    expect(prompt).toContain("USER REQUEST");
    expect(prompt).toContain("TOOLS USED: edit, bash");
    expect(prompt).toContain("truncated");
    expect(prompt.length).toBeLessThan(9000);
  });
});

describe("status line", () => {
  test("says off, or names the model and the cadence", () => {
    expect(advisorStatus({ enabled: false, everyTurns: 1, maxNotes: 4 })).toBe("advisor off");
    expect(advisorStatus({ enabled: true, everyTurns: 1, maxNotes: 4 })).toContain("session model");
    expect(advisorStatus({ enabled: true, everyTurns: 3, maxNotes: 4, model: "glm-4.6" })).toContain("every 3 turns");
  });
});

describe("helpers", () => {
  test("textOf flattens text blocks only", () => {
    expect(textOf({ content: [{ type: "text", text: "a" }, { type: "thinking" }, { type: "text", text: "b" }] })).toBe("ab");
    expect(textOf({ content: "raw" })).toBe("raw");
    expect(textOf(undefined)).toBe("");
  });

  test("withTimeout rejects a hung review", async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toThrow(/timed out/);
    await expect(withTimeout(Promise.resolve("ok"), 50)).resolves.toBe("ok");
  });
});

describe("createAdvisorExtension", () => {
  test("returns undefined when disabled, so it costs nothing", () => {
    expect(createAdvisorExtension({ config: { enabled: false, everyTurns: 1, maxNotes: 4 } })).toBeUndefined();
  });

  test("reviews a finished turn and puts the notes into the next request", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const statuses: string[] = [];
    const sectionsSeen: string[] = [];

    const extension = createAdvisorExtension({
      config: ON,
      complete: async () => '{"notes":["the catch hides network errors"]}',
    })!;

    // Minimal stand-in for pi's ExtensionAPI.
    const api = {
      on(event: string, handler: (...args: any[]) => any) {
        handlers.set(event, handler);
      },
    };
    extension(api as any);

    const ctx = {
      model: { id: "test-model", provider: "qronos" },
      modelRegistry: {
        getApiKeyAndHeaders: async () => ({ apiKey: "k" }),
        find: () => undefined,
        getModelsOfType: () => [],
      },
      ui: { setStatus: (_key: string, text: string) => statuses.push(text) },
    };

    await handlers.get("turn_end")!(
      {
        turnIndex: 1,
        message: { content: [{ type: "text", text: "I changed the catch block." }] },
        toolResults: [{ toolName: "edit" }],
      },
      ctx,
    );

    // The review is fire-and-forget: wait for the microtasks it scheduled.
    await new Promise((resolve) => setTimeout(resolve, 20));

    const startEvent = { systemPromptOptions: {} as { sections?: Record<string, string> } };
    await handlers.get("before_agent_start")!(startEvent);
    sectionsSeen.push(startEvent.systemPromptOptions.sections?.["advisor-notes"] ?? "");
    expect(sectionsSeen[0]).toContain("the catch hides network errors");

    // Injected once only.
    const second = { systemPromptOptions: {} as { sections?: Record<string, string> } };
    await handlers.get("before_agent_start")!(second);
    expect(second.systemPromptOptions.sections?.["advisor-notes"]).toBeUndefined();
  });

  test("a failing reviewer stays silent", async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const extension = createAdvisorExtension({
      config: ON,
      complete: async () => {
        throw new Error("provider down");
      },
    })!;
    extension({ on: (event: string, handler: any) => handlers.set(event, handler) } as any);

    const ctx = {
      model: { id: "m", provider: "qronos" },
      modelRegistry: { getApiKeyAndHeaders: async () => ({ apiKey: "k" }), find: () => undefined, getModelsOfType: () => [] },
      ui: { setStatus: () => {} },
    };
    await handlers.get("turn_end")!(
      { turnIndex: 1, message: { content: [{ type: "text", text: "did work" }] }, toolResults: [] },
      ctx,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    const event = { systemPromptOptions: {} as { sections?: Record<string, string> } };
    await handlers.get("before_agent_start")!(event);
    expect(event.systemPromptOptions.sections?.["advisor-notes"]).toBeUndefined();
  });
});
