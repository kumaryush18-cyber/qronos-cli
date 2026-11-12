import { describe, expect, test, beforeEach } from "bun:test";
import {
  DOUBLE_ESC_THRESHOLD_MS,
  getLastUserPrompt,
  handleEscapeKey,
  setLastUserPrompt,
} from "../src/interrupt-handler";

describe("interrupt-handler (Item ⑫: Interrupt Semantics)", () => {
  beforeEach(() => {
    setLastUserPrompt("");
  });

  test("tracks the last user prompt", () => {
    setLastUserPrompt("implement authentication with oauth");
    expect(getLastUserPrompt()).toBe("implement authentication with oauth");
  });

  test("ignores empty or whitespace-only prompts", () => {
    setLastUserPrompt("first valid prompt");
    setLastUserPrompt("   ");
    expect(getLastUserPrompt()).toBe("first valid prompt");
  });

  test("single escape tap does not trigger recall", () => {
    setLastUserPrompt("test prompt");
    let recalled: string | undefined;

    const triggered = handleEscapeKey(1000, (p) => {
      recalled = p;
    });

    expect(triggered).toBe(false);
    expect(recalled).toBeUndefined();
  });

  test("double escape tap within threshold triggers prompt recall", () => {
    setLastUserPrompt("implement jwt validation");
    let recalled: string | undefined;

    // First tap at 1000ms
    handleEscapeKey(1000);

    // Second tap at 1250ms (within 500ms threshold)
    const triggered = handleEscapeKey(1250, (p) => {
      recalled = p;
    });

    expect(triggered).toBe(true);
    expect(recalled).toBe("implement jwt validation");
  });

  test("escape taps exceeding threshold do not trigger recall", () => {
    setLastUserPrompt("implement jwt validation");
    let recalled: string | undefined;

    // First tap at 1000ms
    handleEscapeKey(1000);

    // Second tap at 2000ms (1000ms delta > 500ms threshold)
    const triggered = handleEscapeKey(2000, (p) => {
      recalled = p;
    });

    expect(triggered).toBe(false);
    expect(recalled).toBeUndefined();
  });
});
