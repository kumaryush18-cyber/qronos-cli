import { describe, expect, test } from "bun:test";
import { DEFAULT_MEMORY_CONFIG, memoryConfigFromEnv } from "../src/memory-config";

describe("memoryConfigFromEnv", () => {
  test("memory is ON by default, with a sane budget", () => {
    const config = memoryConfigFromEnv({});
    expect(config.enabled).toBe(true);
    expect(config.auto).toBe(true);
    expect(config.budgetTokens).toBe(1200);
    expect(config.minTurns).toBe(6);
    expect(config.minIntervalMs).toBe(30 * 60_000);
    expect(config.statusLine).toBe(true);
  });

  test("QRONOS_MEMORY=0 turns the whole feature off", () => {
    for (const value of ["0", "off", "false", "no", "disabled"]) {
      expect(memoryConfigFromEnv({ QRONOS_MEMORY: value }).enabled).toBe(false);
    }
  });

  test("off also disables the background sync", () => {
    expect(memoryConfigFromEnv({ QRONOS_MEMORY: "0" }).auto).toBe(false);
  });

  test("QRONOS_MEMORY_AUTO=0 keeps memory but stops background syncs", () => {
    const config = memoryConfigFromEnv({ QRONOS_MEMORY_AUTO: "0" });
    expect(config.enabled).toBe(true);
    expect(config.auto).toBe(false);
  });

  test("an explicit model is used as given", () => {
    expect(memoryConfigFromEnv({ QRONOS_MEMORY_MODEL: "glm-5.3-flash" }).model).toBe("glm-5.3-flash");
  });

  test("a blank model means the session model", () => {
    expect(memoryConfigFromEnv({ QRONOS_MEMORY_MODEL: "   " }).model).toBeUndefined();
  });

  test("the budget is clamped to a workable range", () => {
    expect(memoryConfigFromEnv({ QRONOS_MEMORY_BUDGET: "10" }).budgetTokens).toBe(200);
    expect(memoryConfigFromEnv({ QRONOS_MEMORY_BUDGET: "999999" }).budgetTokens).toBe(8000);
  });

  test("the turn threshold is clamped and parsed", () => {
    expect(memoryConfigFromEnv({ QRONOS_MEMORY_MIN_TURNS: "3" }).minTurns).toBe(3);
    expect(memoryConfigFromEnv({ QRONOS_MEMORY_MIN_TURNS: "0" }).minTurns).toBe(1);
  });

  test("the interval is minutes and is clamped", () => {
    expect(memoryConfigFromEnv({ QRONOS_MEMORY_INTERVAL_MIN: "5" }).minIntervalMs).toBe(5 * 60_000);
    expect(memoryConfigFromEnv({ QRONOS_MEMORY_INTERVAL_MIN: "0" }).minIntervalMs).toBe(60_000);
  });

  test("bad numbers fall back instead of breaking", () => {
    const config = memoryConfigFromEnv({ QRONOS_MEMORY_BUDGET: "lots", QRONOS_MEMORY_MIN_TURNS: "" });
    expect(config.budgetTokens).toBe(DEFAULT_MEMORY_CONFIG.budgetTokens);
    expect(config.minTurns).toBe(DEFAULT_MEMORY_CONFIG.minTurns);
  });

  test("the status line can be hidden", () => {
    expect(memoryConfigFromEnv({ QRONOS_MEMORY_STATUS: "0" }).statusLine).toBe(false);
  });
});
