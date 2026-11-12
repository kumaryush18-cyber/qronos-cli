import { describe, expect, test } from "bun:test";
import {
  classifyHookResult,
  commandsFor,
  isHookEvent,
  matcherApplies,
  mergeHookConfigs,
  parseHookConfig,
  type HookConfig,
} from "../src/hooks";

describe("hooks: parsing", () => {
  test("parses a well-formed config", () => {
    const cfg = parseHookConfig({
      PreToolUse: [{ matcher: "bash", hooks: [{ type: "command", command: "check.sh" }] }],
    });
    expect(cfg.PreToolUse).toHaveLength(1);
    expect(cfg.PreToolUse![0]!.matcher).toBe("bash");
    expect(cfg.PreToolUse![0]!.hooks[0]!.command).toBe("check.sh");
  });

  test("unknown events are dropped, not fatal", () => {
    const cfg = parseHookConfig({ NotAnEvent: [{ hooks: [{ type: "command", command: "x" }] }] });
    expect(cfg).toEqual({});
  });

  test("one malformed entry does not discard the good ones", () => {
    const cfg = parseHookConfig({
      PreToolUse: [
        { hooks: "not-an-array" },
        { hooks: [{ type: "command", command: "good.sh" }] },
      ],
    });
    expect(cfg.PreToolUse).toHaveLength(1);
    expect(cfg.PreToolUse![0]!.hooks[0]!.command).toBe("good.sh");
  });

  test("non-command hook types are ignored so a foreign config cannot be misread", () => {
    const cfg = parseHookConfig({
      PreToolUse: [{ hooks: [{ type: "http", url: "https://evil" }, { type: "command", command: "ok" }] }],
    });
    expect(cfg.PreToolUse![0]!.hooks).toHaveLength(1);
    expect(cfg.PreToolUse![0]!.hooks[0]!.command).toBe("ok");
  });

  test("blank commands are dropped", () => {
    expect(parseHookConfig({ Stop: [{ hooks: [{ type: "command", command: "   " }] }] })).toEqual({});
  });

  test("a valid timeout is kept and a junk one ignored", () => {
    const cfg = parseHookConfig({
      Stop: [
        {
          hooks: [
            { type: "command", command: "a", timeoutMs: 500 },
            { type: "command", command: "b", timeoutMs: -1 },
            { type: "command", command: "c", timeoutMs: "soon" },
          ],
        },
      ],
    });
    const hooks = cfg.Stop![0]!.hooks;
    expect(hooks[0]!.timeoutMs).toBe(500);
    expect(hooks[1]!.timeoutMs).toBeUndefined();
    expect(hooks[2]!.timeoutMs).toBeUndefined();
  });

  test("garbage input yields an empty config, never a throw", () => {
    for (const raw of [null, undefined, 42, "str", [], [{ x: 1 }]]) {
      expect(parseHookConfig(raw)).toEqual({});
    }
  });

  test("isHookEvent accepts exactly the five events", () => {
    expect(isHookEvent("PreToolUse")).toBe(true);
    expect(isHookEvent("PostToolUse")).toBe(true);
    expect(isHookEvent("nope")).toBe(false);
  });
});

describe("hooks: matching", () => {
  test("no matcher or * matches every tool", () => {
    expect(matcherApplies(undefined, "bash")).toBe(true);
    expect(matcherApplies("*", "bash")).toBe(true);
  });

  test("a regex matcher tests the tool name", () => {
    expect(matcherApplies("bash", "bash")).toBe(true);
    expect(matcherApplies("edit|write", "write")).toBe(true);
    expect(matcherApplies("edit|write", "bash")).toBe(false);
  });

  test("an invalid regex matches nothing rather than everything", () => {
    // A typo must not fire hooks on unrelated tools.
    expect(matcherApplies("([unclosed", "bash")).toBe(false);
  });

  test("commandsFor collects every matching command across matchers", () => {
    const cfg: HookConfig = {
      PreToolUse: [
        { matcher: "bash", hooks: [{ type: "command", command: "a" }] },
        { hooks: [{ type: "command", command: "b" }] },
      ],
    };
    expect(commandsFor(cfg, "PreToolUse", "bash").map((c) => c.command)).toEqual(["a", "b"]);
  });

  test("commandsFor filters out non-matching matchers", () => {
    const cfg: HookConfig = { PreToolUse: [{ matcher: "edit", hooks: [{ type: "command", command: "a" }] }] };
    expect(commandsFor(cfg, "PreToolUse", "bash")).toEqual([]);
  });

  test("commandsFor on an unconfigured event is empty", () => {
    expect(commandsFor({}, "Stop")).toEqual([]);
  });
});

describe("hooks: result classification", () => {
  test("exit 0 allows", () => {
    expect(classifyHookResult(0, "", "")).toEqual({ kind: "allow" });
  });

  test("exit 2 blocks with stderr as the reason", () => {
    expect(classifyHookResult(2, "", "no rm -rf in this repo")).toEqual({
      kind: "block",
      reason: "no rm -rf in this repo",
    });
  });

  test("exit 2 with no output still blocks with a default reason", () => {
    expect(classifyHookResult(2, "", "")).toEqual({ kind: "block", reason: "blocked by hook" });
  });

  test("other nonzero exits warn, they do not block", () => {
    const r = classifyHookResult(1, "", "boom");
    expect(r).toEqual({ kind: "warn", message: "boom" });
  });

  test("JSON decision:block on stdout blocks even with exit 0", () => {
    const out = JSON.stringify({ decision: "block", reason: "protected file" });
    expect(classifyHookResult(0, out, "")).toEqual({ kind: "block", reason: "protected file" });
  });

  test("decision:deny is treated as block", () => {
    const out = JSON.stringify({ decision: "deny", reason: "nope" });
    expect(classifyHookResult(0, out, "")).toEqual({ kind: "block", reason: "nope" });
  });

  test("non-JSON stdout with exit 0 allows", () => {
    expect(classifyHookResult(0, "just some log output", "")).toEqual({ kind: "allow" });
  });

  test("malformed JSON on stdout does not throw", () => {
    expect(classifyHookResult(0, "{ broken", "")).toEqual({ kind: "allow" });
  });
});

describe("hooks: merging", () => {
  test("user hooks run before project hooks and neither is lost", () => {
    const user: HookConfig = { PreToolUse: [{ hooks: [{ type: "command", command: "user.sh" }] }] };
    const project: HookConfig = { PreToolUse: [{ hooks: [{ type: "command", command: "project.sh" }] }] };
    const merged = mergeHookConfigs(user, project);
    expect(merged.PreToolUse!.map((m) => m.hooks[0]!.command)).toEqual(["user.sh", "project.sh"]);
  });

  test("events only present in one side survive", () => {
    const merged = mergeHookConfigs(
      { PreToolUse: [{ hooks: [{ type: "command", command: "u" }] }] },
      { Stop: [{ hooks: [{ type: "command", command: "p" }] }] },
    );
    expect(merged.PreToolUse).toHaveLength(1);
    expect(merged.Stop).toHaveLength(1);
  });

  test("merging two empties yields an empty config", () => {
    expect(mergeHookConfigs({}, {})).toEqual({});
  });
});
