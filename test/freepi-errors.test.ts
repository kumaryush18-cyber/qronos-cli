// Two free-pi failures with a plain sentence, and nothing invented for the rest.
import { describe, expect, test } from "bun:test";
import {
  FREEPI_CONCURRENT_MESSAGE,
  FREEPI_TOKEN_REJECTED_MESSAGE,
  FREEPI_UNAVAILABLE_MESSAGE,
  isConcurrentSessionError,
  isRateLimitError,
  isTokenRejectedError,
  isUnavailableError,
  maskFreepiError,
  wantsConcurrentRetry,
} from "../src/freepi-errors";

describe("isConcurrentSessionError", () => {
  test("the server's several ways of saying it", () => {
    expect(isConcurrentSessionError("concurrent_session")).toBe(true);
    expect(isConcurrentSessionError("Concurrent session detected")).toBe(true);
    expect(isConcurrentSessionError("You already have an active request")).toBe(true);
    expect(isConcurrentSessionError("only one request at a time")).toBe(true);
    expect(isConcurrentSessionError("session is busy")).toBe(true);
  });

  test("our own sentence still counts, so a mapped message is not lost", () => {
    expect(isConcurrentSessionError(FREEPI_CONCURRENT_MESSAGE)).toBe(true);
  });

  test("anything else is not", () => {
    expect(isConcurrentSessionError("model not found")).toBe(false);
    expect(isConcurrentSessionError("rate limit exceeded")).toBe(false);
    expect(isConcurrentSessionError(undefined)).toBe(false);
    expect(isConcurrentSessionError("")).toBe(false);
  });
});

describe("isRateLimitError", () => {
  test("the usual words and the status", () => {
    expect(isRateLimitError("rate limit exceeded")).toBe(true);
    expect(isRateLimitError("HTTP 429")).toBe(true);
    expect(isRateLimitError("Too many requests")).toBe(true);
  });

  test("a plain failure is not a rate limit", () => {
    expect(isRateLimitError("internal error")).toBe(false);
  });
});

describe("isUnavailableError / isTokenRejectedError", () => {
  test("high usage, 5xx and overload are the same story", () => {
    expect(isUnavailableError("503 service unavailable")).toBe(true);
    expect(isUnavailableError("overloaded")).toBe(true);
    expect(isUnavailableError("high usage")).toBe(true);
    expect(isUnavailableError("plain failure")).toBe(false);
  });

  test("a refused key is its own case", () => {
    expect(isTokenRejectedError("401 unauthorised")).toBe(true);
    expect(isTokenRejectedError("invalid api key")).toBe(true);
    expect(isTokenRejectedError("500 boom")).toBe(false);
  });
});

describe("maskFreepiError", () => {
  test("a rate limit becomes the masked unavailable sentence", () => {
    expect(maskFreepiError("429 rate limit exceeded")).toBe(FREEPI_UNAVAILABLE_MESSAGE);
    expect(FREEPI_UNAVAILABLE_MESSAGE).toContain("high usage");
    // The words the user sees never name the provider behind the models.
    expect(FREEPI_UNAVAILABLE_MESSAGE).not.toContain("free-pi");
    expect(FREEPI_TOKEN_REJECTED_MESSAGE).not.toContain("free-pi");
    expect(FREEPI_CONCURRENT_MESSAGE).not.toContain("free-pi");
  });

  test("the provider's own 5xx is masked too", () => {
    expect(maskFreepiError("503: upstream overloaded")).toBe(FREEPI_UNAVAILABLE_MESSAGE);
  });

  test("a concurrent session never mentions the plumbing", () => {
    expect(maskFreepiError("concurrent_session")).toBe(FREEPI_CONCURRENT_MESSAGE);
    expect(FREEPI_CONCURRENT_MESSAGE).not.toContain("concurrent_session");
    expect(FREEPI_CONCURRENT_MESSAGE).toContain("retry shortly");
  });

  test("a refused token is a short generic sentence", () => {
    expect(maskFreepiError("401 unauthorized")).toBe(FREEPI_TOKEN_REJECTED_MESSAGE);
    expect(FREEPI_TOKEN_REJECTED_MESSAGE).toContain("retry shortly");
    expect(FREEPI_TOKEN_REJECTED_MESSAGE).not.toContain("token");
  });

  test("an unrecognised failure keeps the server's own words", () => {
    expect(maskFreepiError("model particle is retired")).toBeUndefined();
  });
});

describe("wantsConcurrentRetry", () => {
  test("only the busy-token words ask for the one retry", () => {
    expect(wantsConcurrentRetry("concurrent_session")).toBe(true);
    expect(wantsConcurrentRetry("429 rate limit")).toBe(false);
    expect(wantsConcurrentRetry(undefined)).toBe(false);
  });
});
