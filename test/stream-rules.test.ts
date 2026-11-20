// Tests for the stream-rule matcher. They are the safety net for a feature that
// aborts a live model stream, so they cover the three ways it can go wrong:
// a bad rule file, a rule that fires twice (loop), and a pattern that only
// appears once two stream chunks are joined.
import { describe, expect, test } from "bun:test";
import {
  formatRuleReminder,
  parseStreamRules,
  ruleNotice,
  StreamRuleWatcher,
  OVERLAP_CHARS,
} from "../src/stream-rules";
import { assistantText, loadStreamRules } from "../src/stream-rules-extension";

const rulesOf = (raw: unknown, disabled: string[] = []) => parseStreamRules(raw, disabled).rules;

describe("parseStreamRules", () => {
  test("accepts an array and a { rules: [] } envelope", () => {
    const rule = { name: "no-eval", pattern: "\\beval\\(", message: "No eval." };
    expect(rulesOf([rule]).length).toBe(1);
    expect(rulesOf({ rules: [rule] }).length).toBe(1);
    expect(rulesOf(undefined).length).toBe(0);
  });

  test("drops malformed entries with a warning instead of throwing", () => {
    const parsed = parseStreamRules([
      { name: "no-pattern", message: "x" },
      { name: "bad-regex", pattern: "([", message: "x" },
      { name: "ok", pattern: "foo", message: "stop" },
    ]);
    expect(parsed.rules.map((r) => r.name)).toEqual(["ok"]);
    expect(parsed.warnings.length).toBe(2);
  });

  test("skips disabled rules by name and by flag", () => {
    const raw = [
      { name: "a", pattern: "aaa", message: "A" },
      { name: "b", pattern: "bbb", message: "B", disabled: true },
    ];
    expect(rulesOf(raw).map((r) => r.name)).toEqual(["a"]);
    expect(rulesOf(raw, ["a"]).map((r) => r.name)).toEqual([]);
  });

  test("is case-insensitive by default and drops the sticky flags", () => {
    const [rule] = rulesOf([{ name: "x", pattern: "EVAL", message: "no", flags: "gi" }]);
    rule.regex.lastIndex = 5;
    expect(rule.regex.test("please eval(x)")).toBe(true);
  });

  test("keeps the first of two rules with the same name", () => {
    const parsed = parseStreamRules([
      { name: "dup", pattern: "one", message: "first" },
      { name: "dup", pattern: "two", message: "second" },
    ]);
    expect(parsed.rules.length).toBe(1);
    expect(parsed.rules[0].message).toBe("first");
    expect(parsed.warnings.length).toBe(1);
  });
});

describe("StreamRuleWatcher", () => {
  const rules = rulesOf([
    { name: "no-eval", pattern: "\\beval\\s*\\(", message: "Never call eval()." },
    { name: "no-inner-html", pattern: "dangerouslySetInnerHTML", message: "Sanitize instead." },
  ]);

  test("fires once per turn and does not fire again while streaming continues", () => {
    const watcher = new StreamRuleWatcher(rules);
    expect(watcher.push("const value = ")).toBeNull();
    const fired = watcher.push("const value = eval(input);");
    expect(fired?.name).toBe("no-eval");
    expect(watcher.push("const value = eval(input); eval(other);")).toBeNull();
    expect(watcher.firedNames()).toEqual(["no-eval"]);
  });

  test("reset re-arms every rule for the next turn", () => {
    const watcher = new StreamRuleWatcher(rules);
    watcher.push("eval(x)");
    watcher.reset();
    expect(watcher.push("eval(x)")?.name).toBe("no-eval");
  });

  test("catches a pattern split across two chunks (overlap window)", () => {
    const watcher = new StreamRuleWatcher(rules);
    expect(watcher.push("dangerouslySet")).toBeNull();
    expect(watcher.push("dangerouslySetInnerHTML={{ __html: x }}")?.name).toBe("no-inner-html");
  });

  test("still sees text older than the overlap window when the match starts early", () => {
    const watcher = new StreamRuleWatcher(rules);
    const long = "a".repeat(OVERLAP_CHARS + 50);
    expect(watcher.push(`eval(x)${long}`)?.name).toBe("no-eval");
  });

  test("ignores empty text and rules that already fired", () => {
    const watcher = new StreamRuleWatcher(rules);
    expect(watcher.push("")).toBeNull();
    watcher.push("eval(x)");
    expect(watcher.push("eval(y)")).toBeNull();
  });
});

describe("loadStreamRules", () => {
  const files: Record<string, string> = {
    "/project/stream-rules.json": JSON.stringify({ rules: [{ name: "p", pattern: "pp", message: "project" }] }),
    "/user/stream-rules.json": JSON.stringify([
      { name: "p", pattern: "pp2", message: "shadowed" },
      { name: "u", pattern: "uu", message: "user" },
    ]),
    "/broken/stream-rules.json": "{ not json",
  };
  const readFile = (path: string) => files[path];

  test("merges project then user rules and reports shadowed names", () => {
    const loaded = loadStreamRules({
      projectPath: "/project/stream-rules.json",
      userPath: "/user/stream-rules.json",
      readFile,
    });
    expect(loaded.rules.map((r) => r.name)).toEqual(["p", "u"]);
    expect(loaded.warnings.some((w) => w.includes("already defined"))).toBe(true);
  });

  test("a broken file is skipped, not fatal", () => {
    const loaded = loadStreamRules({ projectPath: "/broken/stream-rules.json", readFile });
    expect(loaded.rules).toEqual([]);
    expect(loaded.invalidFiles).toEqual(["/broken/stream-rules.json"]);
  });

  test("a missing file is simply absent", () => {
    const loaded = loadStreamRules({ projectPath: "/nope.json", userPath: "/nope2.json", readFile });
    expect(loaded.rules).toEqual([]);
    expect(loaded.warnings).toEqual([]);
  });
});

describe("formatting", () => {
  test("reminder names the rule and asks for a rewrite, not a chat reply", () => {
    const [rule] = rulesOf([{ name: "no-eval", pattern: "eval\\(", message: "Parse it properly." }]);
    const text = formatRuleReminder(rule);
    expect(text).toContain('<stream-rule name="no-eval">');
    expect(text).toContain("Parse it properly.");
    expect(text).toContain("do not mention this note to the user");
    expect(ruleNotice(rule)).toContain("no-eval");
  });

  test("assistantText flattens text and thinking blocks and ignores the rest", () => {
    expect(assistantText("plain")).toBe("plain");
    expect(
      assistantText([
        { type: "text", text: "hello " },
        { type: "thinking", thinking: "hmm" },
        { type: "toolCall", name: "bash" },
      ]),
    ).toBe("hello hmm");
    expect(assistantText(undefined)).toBe("");
  });
});
