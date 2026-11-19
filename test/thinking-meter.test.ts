import { describe, expect, test } from "bun:test";
import {
  estimateTokensFromChars,
  formatTokenCount,
  OutputTokenCounter,
} from "../src/thinking-meter";

describe("formatTokenCount", () => {
  test("small counts stay exact", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(847)).toBe("847");
    expect(formatTokenCount(999)).toBe("999");
  });

  test("thousands use one decimal below 10k, whole numbers above", () => {
    expect(formatTokenCount(1000)).toBe("1.0k");
    expect(formatTokenCount(1234)).toBe("1.2k");
    expect(formatTokenCount(12_340)).toBe("12k");
    expect(formatTokenCount(199_999)).toBe("200k");
  });

  test("millions use one decimal", () => {
    expect(formatTokenCount(1_240_000)).toBe("1.2M");
    expect(formatTokenCount(1_000_000)).toBe("1.0M");
  });

  test("unknown or invalid input returns undefined, never a fake number", () => {
    expect(formatTokenCount(null)).toBeUndefined();
    expect(formatTokenCount(undefined)).toBeUndefined();
    expect(formatTokenCount(Number.NaN)).toBeUndefined();
    expect(formatTokenCount(-5)).toBeUndefined();
  });
});

describe("estimateTokensFromChars", () => {
  test("four characters are one token", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(3)).toBe(1);
    expect(estimateTokensFromChars(400)).toBe(100);
  });

  test("invalid input counts as zero, never a fake number", () => {
    expect(estimateTokensFromChars(-10)).toBe(0);
    expect(estimateTokensFromChars(Number.NaN)).toBe(0);
  });
});

describe("OutputTokenCounter", () => {
  const assistant = (output?: number) => ({ role: "assistant", usage: output === undefined ? {} : { output } });
  const delta = (text: string) => ({ type: "text_delta", delta: text });

  test("starts at zero and grows with the streamed characters", () => {
    const counter = new OutputTokenCounter();
    counter.messageStart(assistant());
    expect(counter.tokens()).toBe(0);
    counter.messageUpdate(assistant(), delta("a".repeat(400)));
    expect(counter.tokens()).toBe(100);
    counter.messageUpdate(assistant(), delta("a".repeat(400)));
    expect(counter.tokens()).toBe(200);
  });

  test("the provider's own count wins when it is larger", () => {
    const counter = new OutputTokenCounter();
    counter.messageStart(assistant());
    counter.messageUpdate(assistant(), delta("a".repeat(40))); // estimate 10
    counter.messageUpdate(assistant(1530), delta("")); // real 1530
    expect(counter.tokens()).toBe(1530);
  });

  test("the estimate is used when the provider has not reported anything yet", () => {
    const counter = new OutputTokenCounter();
    counter.messageStart(assistant());
    counter.messageUpdate(assistant(0), delta("a".repeat(1200))); // estimate 300
    expect(counter.tokens()).toBe(300);
  });

  test("a run with tool calls keeps adding up instead of restarting", () => {
    const counter = new OutputTokenCounter();
    counter.messageStart(assistant());
    counter.messageUpdate(assistant(), delta("a".repeat(1200)));
    counter.messageEnd(assistant(310));
    expect(counter.tokens()).toBe(310);
    counter.messageStart(assistant());
    counter.messageUpdate(assistant(), delta("a".repeat(400)));
    expect(counter.tokens()).toBe(410);
    counter.messageEnd(assistant(100));
    expect(counter.tokens()).toBe(410);
  });

  test("the number never goes down inside a run", () => {
    const counter = new OutputTokenCounter();
    counter.messageStart(assistant());
    let previous = 0;
    for (const size of [40, 400, 40, 4000, 400, 8000]) {
      counter.messageUpdate(assistant(), delta("a".repeat(size)));
      const current = counter.tokens();
      expect(current).toBeGreaterThanOrEqual(previous);
      previous = current;
    }
  });

  test("reset starts a new run from zero", () => {
    const counter = new OutputTokenCounter();
    counter.messageStart(assistant());
    counter.messageUpdate(assistant(), delta("a".repeat(4000)));
    counter.messageEnd(assistant(1000));
    expect(counter.tokens()).toBe(1000);
    counter.reset();
    expect(counter.tokens()).toBe(0);
  });

  test("user and tool messages are ignored", () => {
    const counter = new OutputTokenCounter();
    counter.messageStart({ role: "user" });
    counter.messageUpdate({ role: "user" }, delta("a".repeat(4000)));
    counter.messageEnd({ role: "user" });
    expect(counter.tokens()).toBe(0);
  });
});
