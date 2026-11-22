import { describe, expect, test } from "bun:test";
import { applySchema } from "../src/workflow-schema";

const ok = (text: string, data?: unknown) => ({ ok: true as const, text, data });

describe("one test for every path", () => {
  test("no schema means no test", () => {
    const result = ok("just words");
    expect(applySchema(result, undefined)).toBe(result);
    expect(applySchema(result, null)).toBe(result);
  });

  test("an answer that matches keeps its text and gains its data", () => {
    const result = applySchema(ok('{"count": 2}'), {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ count: 2 });
  });

  test("JSON buried in prose is still read", () => {
    const result = applySchema(ok('Here it is:\n```json\n{"count": 3}\n```'), {
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ count: 3 });
  });

  test("an answer that does not match becomes a failure with the reason", () => {
    const result = applySchema(ok("hi"), { type: "object", required: ["total"] });
    expect(result.ok).toBe(false);
    expect(result.error).toStartWith("schema not satisfied:");
    // The words are kept: a failure still has to be readable.
    expect(result.text).toBe("hi");
  });

  test("a failure is left alone: its reason is more useful than a schema note", () => {
    const failed = { ok: false as const, text: "", error: "the provider said no" };
    expect(applySchema(failed, { type: "object" })).toBe(failed);
  });

  test("an impossible pattern fails, which is what a retry must see again", () => {
    // The same schema on the second try has to fail the same way, or a retry
    // would look like a success nobody earned.
    const schema = { type: "object", properties: { value: { type: "string", pattern: "a^b" } }, required: ["value"] };
    expect(applySchema(ok('{"value":"ab"}'), schema).ok).toBe(false);
  });
});
