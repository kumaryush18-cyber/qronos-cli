// `qronos freepi login`: the device flow, consent, and the promise that the
// token is returned to be saved and never printed by this module.
import { describe, expect, test } from "bun:test";
import {
  FREEPI_CONSENT_TEXT,
  FREEPI_CONSENT_VERSION,
  acceptConsent,
  parseDeviceStart,
  parseTokenPoll,
  pollForToken,
  runFreepiLogin,
  startDeviceLogin,
} from "../src/freepi-login";

const device = {
  session_id: "11111111-1111-4111-8111-111111111111",
  user_code: "ABCD-1234",
  verification_uri: "https://github.com/login/device",
  verification_uri_complete: "https://github.com/login/device?code=ABCD-1234",
  interval: 5,
  expires_in: 900,
};

describe("parseDeviceStart", () => {
  test("the whole answer is read", () => {
    const start = parseDeviceStart(device)!;
    expect(start.sessionId).toBe(device.session_id);
    expect(start.userCode).toBe("ABCD-1234");
    expect(start.verificationUriComplete).toContain("ABCD");
    expect(start.intervalSeconds).toBe(5);
  });

  test("a missing field means we cannot start, not a guess", () => {
    expect(parseDeviceStart({ ...device, user_code: undefined })).toBeUndefined();
    expect(parseDeviceStart({})).toBeUndefined();
    expect(parseDeviceStart(null)).toBeUndefined();
  });

  test("a silly interval is clamped", () => {
    expect(parseDeviceStart({ ...device, interval: 0 })!.intervalSeconds).toBe(2);
    expect(parseDeviceStart({ ...device, interval: 600 })!.intervalSeconds).toBe(30);
  });
});

describe("parseTokenPoll", () => {
  test("pending, with the server's own retry hint", () => {
    expect(parseTokenPoll({ status: "pending", retry_after: 7 })).toEqual({ status: "pending", retryAfterSeconds: 7 });
  });

  test("issued", () => {
    expect(parseTokenPoll({ token: "fp_real_token" })).toEqual({ status: "issued", token: "fp_real_token" });
  });

  test("consent required arrives as a 403 body", () => {
    const poll = parseTokenPoll({ code: "consent_required", message: "Accept the terms" }, 403);
    expect(poll.status).toBe("consent");
  });

  test("junk is pending, never issued", () => {
    expect(parseTokenPoll(undefined).status).toBe("pending");
    expect(parseTokenPoll({ token: "" }).status).toBe("pending");
  });
});

describe("startDeviceLogin", () => {
  test("a refusal is a plain error", async () => {
    const fetchImpl = (async () => new Response("no", { status: 500 })) as unknown as typeof fetch;
    await expect(startDeviceLogin("https://api.test", fetchImpl)).rejects.toThrow("HTTP 500");
  });

  test("an unreadable answer is a plain error", async () => {
    const fetchImpl = (async () => Response.json({ nothing: true })) as unknown as typeof fetch;
    await expect(startDeviceLogin("https://api.test", fetchImpl)).rejects.toThrow("could not read");
  });
});

describe("pollForToken", () => {
  test("a network failure is pending, not a failed login", async () => {
    const fetchImpl = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await pollForToken("https://api.test", device.session_id, fetchImpl)).toEqual({ status: "pending" });
  });

  test("204 is pending", async () => {
    const fetchImpl = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    expect((await pollForToken("https://api.test", device.session_id, fetchImpl)).status).toBe("pending");
  });
});

describe("acceptConsent", () => {
  test("sends free-pi's own consent version", async () => {
    let body: any;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    expect(await acceptConsent("https://api.test", device.session_id, fetchImpl)).toBe(true);
    expect(body.consent_version).toBe(FREEPI_CONSENT_VERSION);
    expect(body.session_id).toBe(device.session_id);
  });

  test("the invite code travels with the consent", async () => {
    let body: any;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    await acceptConsent("https://api.test", device.session_id, fetchImpl, { signupSrc: "qronos-cli", referralCode: "gghg7ytd" });
    expect(body.signup_src).toBe("qronos-cli");
    expect(body.referral_code).toBe("gghg7ytd");
  });

  test("a failure is false, never a throw", async () => {
    const fetchImpl = (async () => {
      throw new Error("nope");
    }) as unknown as typeof fetch;
    expect(await acceptConsent("https://api.test", device.session_id, fetchImpl)).toBe(false);
  });
});

describe("runFreepiLogin", () => {
  function harness(polls: Array<() => Response>, options: { consent?: boolean; deadlineMs?: number } = {}) {
    const log: string[] = [];
    const opened: string[] = [];
    const questions: string[] = [];
    let index = 0;
    let now = 0;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/auth/github/device") return Response.json(device);
      if (path === "/auth/consent") return Response.json({ ok: true });
      if (path === "/auth/token") {
        const next = polls[Math.min(index, polls.length - 1)]!;
        index += 1;
        return next();
      }
      return new Response(String(init?.body ?? ""), { status: 404 });
    }) as unknown as typeof fetch;
    return {
      log,
      opened,
      questions,
      get pollsSeen() {
        return index;
      },
      deps: {
        baseUrl: "https://api.test",
        open: (url: string) => opened.push(url),
        log: (line: string) => log.push(line),
        confirm: async (question: string) => {
          questions.push(question);
          return options.consent ?? false;
        },
        fetchImpl,
        sleep: async (ms: number) => {
          now += ms;
        },
        now: () => now,
        deadlineMs: options.deadlineMs ?? 60_000,
        inviteUrl: "https://freepi.ai/?ref=gghg7ytd",
        attribution: { signupSrc: "qronos-cli", referralCode: "gghg7ytd" },
      },
    };
  }

  test("pending then issued: the token comes back to be saved", async () => {
    const h = harness([() => Response.json({ status: "pending" }), () => Response.json({ token: "fp_real_token" })]);
    const result = await runFreepiLogin(h.deps);
    expect(result).toEqual({ ok: true, token: "fp_real_token" });
    expect(h.opened[0]).toContain("ABCD-1234");
    expect(h.log.join("\n")).toContain("ABCD-1234");
    // the invite link is shown to a new user, and it is not the token
    expect(h.log.join("\n")).toContain("https://freepi.ai/?ref=gghg7ytd");
    // never the token itself
    expect(h.log.join("\n")).not.toContain("fp_real_token");
  });

  test("consent asked, refused: nothing is returned", async () => {
    const h = harness([() => new Response(JSON.stringify({ code: "consent_required", message: "accept" }), { status: 403 })], {
      consent: false,
    });
    const result = await runFreepiLogin(h.deps);
    expect(result.ok).toBe(false);
    expect(h.questions).toHaveLength(1);
    expect(h.log.join("\n")).toContain(FREEPI_CONSENT_TEXT.split("\n")[1]!);
  });

  test("consent asked and accepted: the login continues", async () => {
    const h = harness(
      [
        () => new Response(JSON.stringify({ code: "consent_required" }), { status: 403 }),
        () => Response.json({ token: "fp_real_token" }),
      ],
      { consent: true },
    );
    const result = await runFreepiLogin(h.deps);
    expect(result).toEqual({ ok: true, token: "fp_real_token" });
  });

  test("the deadline ends the wait with a sentence, not a hang", async () => {
    const h = harness([() => Response.json({ status: "pending" })], { deadlineMs: 20_000 });
    const result = await runFreepiLogin(h.deps);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("did not finish");
    expect(h.pollsSeen).toBeGreaterThan(1);
  });

  test("a device refusal is reported as it came", async () => {
    const log: string[] = [];
    const result = await runFreepiLogin({
      baseUrl: "https://api.test",
      open: () => {},
      log: (line) => log.push(line),
      confirm: async () => false,
      fetchImpl: (async () => new Response("no", { status: 429 })) as unknown as typeof fetch,
      sleep: async () => {},
      now: () => 0,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("429");
  });
});
