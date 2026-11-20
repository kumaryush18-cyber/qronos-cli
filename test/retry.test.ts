import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_RETRY_SCHEDULE_MS,
  MAX_RETRIES_ALLOWED,
  abortableSleep,
  classifyError,
  formatRetryLine,
  retryDelayMs,
  retryPolicyFromEnv,
  withRetry,
} from "../src/retry";

const policy = (over: Partial<ReturnType<typeof retryPolicyFromEnv>> = {}) => ({
  enabled: true,
  maxRetries: 3,
  scheduleMs: [10_000, 30_000, 60_000],
  maxWaitMs: 60_000,
  ...over,
});

describe("retry policy from the environment", () => {
  test("the defaults are the ones we promised: 10 retries, 10s/30s/60s", () => {
    const p = retryPolicyFromEnv({});
    expect(p.enabled).toBe(true);
    expect(p.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(p.scheduleMs).toEqual(DEFAULT_RETRY_SCHEDULE_MS);
    expect(p.maxWaitMs).toBe(60_000);
  });

  test("QRONOS_RETRY=0 turns retries off", () => {
    expect(retryPolicyFromEnv({ QRONOS_RETRY: "0" }).enabled).toBe(false);
  });

  test("the retry count is capped at 15, like Claude Code", () => {
    expect(retryPolicyFromEnv({ QRONOS_MAX_RETRIES: "99" }).maxRetries).toBe(MAX_RETRIES_ALLOWED);
    expect(retryPolicyFromEnv({ QRONOS_MAX_RETRIES: "-4" }).maxRetries).toBe(0);
    expect(retryPolicyFromEnv({ QRONOS_MAX_RETRIES: "abc" }).maxRetries).toBe(DEFAULT_MAX_RETRIES);
  });

  test("a custom schedule is read in seconds", () => {
    expect(retryPolicyFromEnv({ QRONOS_RETRY_SCHEDULE: "1,2,3" }).scheduleMs).toEqual([1000, 2000, 3000]);
    expect(retryPolicyFromEnv({ QRONOS_RETRY_SCHEDULE: "nonsense" }).scheduleMs).toEqual(DEFAULT_RETRY_SCHEDULE_MS);
  });
});

describe("the delay for each retry", () => {
  test("follows 10s, 30s, then 60s forever", () => {
    const p = policy();
    expect([1, 2, 3, 4, 5].map((n) => retryDelayMs(p, n))).toEqual([10_000, 30_000, 60_000, 60_000, 60_000]);
  });

  test("never exceeds maxWaitMs", () => {
    expect(retryDelayMs(policy({ maxWaitMs: 5_000 }), 1)).toBe(5_000);
  });

  test("a single-value schedule repeats that value", () => {
    expect([1, 2, 3].map((n) => retryDelayMs(policy({ scheduleMs: [7_000] }), n))).toEqual([7_000, 7_000, 7_000]);
  });

  test("attempt 0 does not crash", () => {
    expect(retryDelayMs(policy(), 0)).toBe(10_000);
  });
});

describe("which errors are retried", () => {
  test("our gateway's own wording is retried", () => {
    expect(classifyError("The selected model is temporarily unavailable. Please retry shortly.")).toBe("retry");
    expect(classifyError("529 overloaded")).toBe("retry");
    expect(classifyError("Bad gateway")).toBe("retry");
  });

  test("pi's list still works: rate limits, 5xx, network, timeouts", () => {
    expect(classifyError("429 too many requests")).toBe("retry");
    expect(classifyError("503 service unavailable")).toBe("retry");
    expect(classifyError("fetch failed")).toBe("retry");
    expect(classifyError("Request timed out")).toBe("retry");
    expect(classifyError("socket hang up")).toBe("retry");
  });

  test("billing and auth failures stop at once", () => {
    expect(classifyError("Your Token Plan (Coding Tokens) balance is exhausted (0 tokens remaining).")).toBe("stop");
    expect(classifyError("insufficient_quota")).toBe("stop");
    expect(classifyError("402 Payment Required")).toBe("stop");
    expect(classifyError("401 Unauthorized")).toBe("stop");
    expect(classifyError("invalid api key")).toBe("stop");
  });

  test("a certificate problem is not retried: ten waits cannot fix it", () => {
    expect(classifyError("unable to get local issuer certificate")).toBe("stop");
  });

  test("an unknown error stops, like Claude Code: retrying blind wastes minutes", () => {
    expect(classifyError("")).toBe("stop");
    expect(classifyError(undefined)).toBe("stop");
    expect(classifyError("something strange happened")).toBe("stop");
  });
});

describe("withRetry", () => {
  const instantSleep = async () => true;

  test("a good first try is not retried", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        return "ok";
      },
      { policy: policy(), sleep: instantSleep },
    );
    expect(out).toEqual({ ok: true, value: "ok", attempts: 1 });
    expect(calls).toBe(1);
  });

  test("a transient failure is retried and then succeeds", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw new Error("model is temporarily unavailable");
        return "done";
      },
      { policy: policy(), sleep: instantSleep },
    );
    expect(out).toMatchObject({ ok: true, value: "done", attempts: 3 });
  });

  test("a failure inside a successful result is caught by failureOf", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        return { stopReason: calls < 2 ? "error" : "stop", errorMessage: "503 service unavailable" };
      },
      {
        policy: policy(),
        sleep: instantSleep,
        failureOf: (value) => (value.stopReason === "error" ? value.errorMessage : undefined),
      },
    );
    expect(out).toMatchObject({ ok: true, attempts: 2 });
  });

  test("the waits follow the schedule and each one is reported", async () => {
    const waits: number[] = [];
    const notices: string[] = [];
    const out = await withRetry(
      async () => {
        throw new Error("429 too many requests");
      },
      {
        policy: policy(),
        sleep: async (ms) => {
          waits.push(ms);
          return true;
        },
        onRetry: (info) => notices.push(formatRetryLine(info)),
      },
    );
    expect(out).toMatchObject({ ok: false, attempts: 4 });
    expect(waits).toEqual([10_000, 30_000, 60_000]);
    expect(notices).toEqual([
      "Retrying in 10s · attempt 1/3 — 429 too many requests",
      "Retrying in 30s · attempt 2/3 — 429 too many requests",
      "Retrying in 60s · attempt 3/3 — 429 too many requests",
    ]);
  });

  test("a billing failure stops after one request", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        throw new Error("Your Token Plan (Coding Tokens) balance is exhausted");
      },
      { policy: policy(), sleep: instantSleep },
    );
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: false, attempts: 1 });
  });

  test("retries off means exactly one request", async () => {
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        throw new Error("503 service unavailable");
      },
      { policy: policy({ enabled: false }), sleep: instantSleep },
    );
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: false, attempts: 1 });
  });

  test("Escape during a wait stops at once and says it was aborted", async () => {
    const controller = new AbortController();
    const out = await withRetry(
      async () => {
        throw new Error("503 service unavailable");
      },
      {
        policy: policy(),
        signal: controller.signal,
        sleep: async () => {
          controller.abort();
          return false;
        },
      },
    );
    expect(out).toMatchObject({ ok: false, aborted: true, attempts: 1 });
  });

  test("an already-aborted signal does not send a request", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const out = await withRetry(
      async () => {
        calls++;
        return "no";
      },
      { policy: policy(), signal: controller.signal, sleep: instantSleep },
    );
    expect(calls).toBe(0);
    expect(out).toMatchObject({ ok: false, aborted: true });
  });

  test("the final answer after an abort keeps the last error text", async () => {
    const controller = new AbortController();
    const out = await withRetry(
      async () => {
        throw new Error("503 service unavailable");
      },
      { policy: policy(), signal: controller.signal, sleep: async () => { controller.abort(); return false; } },
    );
    expect((out as any).error).toContain("503");
  });
});

describe("abortableSleep", () => {
  test("resolves true after the wait", async () => {
    expect(await abortableSleep(1)).toBe(true);
  });

  test("resolves false when the signal fires first", async () => {
    const controller = new AbortController();
    const waiting = abortableSleep(5_000, controller.signal);
    controller.abort();
    expect(await waiting).toBe(false);
  });
});

describe("withRetry: work already done is never replayed", () => {
  test("canRetry=false stops after the failure, even for a transient error", async () => {
    let calls = 0;
    let produced = false;
    const out = await withRetry(
      async () => {
        calls++;
        produced = true; // some output was streamed or a tool ran
        throw new Error("503 service unavailable");
      },
      {
        policy: { enabled: true, maxRetries: 5, scheduleMs: [1], maxWaitMs: 10 },
        sleep: async () => true,
        canRetry: () => !produced,
      },
    );
    expect(calls).toBe(1);
    expect(out).toMatchObject({ ok: false, attempts: 1 });
  });
});

describe("the main chat's retry settings", () => {
  test("are built from the same environment as our own loop", async () => {
    const { mainChatRetrySettings } = await import("../src/pi-launch");
    const settings = mainChatRetrySettings();
    expect(settings.enabled).toBe(true);
    expect(settings.maxRetries).toBe(DEFAULT_MAX_RETRIES);
    expect(settings.baseDelayMs).toBe(10_000);
    expect(settings.maxAgentDelayMs).toBe(60_000);
  });

  test("a custom first delay and cap are honoured, so 10/30/60 is possible there too", async () => {
    const { mainChatRetrySettings } = await import("../src/pi-launch");
    process.env.QRONOS_RETRY_SCHEDULE = "10,30,60";
    process.env.QRONOS_RETRY_MAX_WAIT_MS = "30000";
    try {
      const settings = mainChatRetrySettings();
      expect(settings.baseDelayMs).toBe(10_000);
      expect(settings.maxAgentDelayMs).toBe(30_000);
    } finally {
      delete process.env.QRONOS_RETRY_SCHEDULE;
      delete process.env.QRONOS_RETRY_MAX_WAIT_MS;
    }
  });
});
