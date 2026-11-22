import { describe, expect, test } from "bun:test";
import { formatContextSize, modelWithContext } from "../src/workflow-context-size";

describe("a context size as a tag", () => {
  test("a million tokens is 1m", () => {
    expect(formatContextSize(1_000_000)).toBe("1m");
  });

  test("a real 1 MiB window is also 1m", () => {
    expect(formatContextSize(1_048_576)).toBe("1m");
  });

  test("two and a half million keeps one decimal", () => {
    expect(formatContextSize(2_500_000)).toBe("2.5m");
  });

  test("a large window is 200k", () => {
    expect(formatContextSize(200_000)).toBe("200k");
  });

  test("a small window is 32k", () => {
    expect(formatContextSize(32_000)).toBe("32k");
  });

  test("under a thousand is the number", () => {
    expect(formatContextSize(800)).toBe("800");
  });

  test("nothing known means no tag", () => {
    expect(formatContextSize(undefined)).toBeUndefined();
    expect(formatContextSize(null)).toBeUndefined();
    expect(formatContextSize(0)).toBeUndefined();
    expect(formatContextSize(-5)).toBeUndefined();
    expect(formatContextSize(Number.NaN)).toBeUndefined();
  });
});

describe("the model name with its size", () => {
  test("the tag follows the name", () => {
    expect(modelWithContext("claude-haiku-5.5", 1_000_000)).toBe("claude-haiku-5.5 [1m]");
  });

  test("an unknown size leaves the name alone", () => {
    expect(modelWithContext("claude-haiku-5.5", undefined)).toBe("claude-haiku-5.5");
  });

  test("an unknown model still shows the tag", () => {
    expect(modelWithContext(undefined, 200_000)).toBe("[200k]");
  });

  test("nothing known is an empty string, not brackets", () => {
    expect(modelWithContext("", undefined)).toBe("");
  });
});
