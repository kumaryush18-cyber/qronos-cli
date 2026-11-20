import { describe, expect, test } from "bun:test";
import {
  describeSchema,
  extractJson,
  normalizeSchemaInput,
  repairPrompt,
  schemaInstruction,
  validateJsonSchema,
} from "../src/agent-schema";

const REPORT_SCHEMA = {
  type: "object",
  required: ["summary", "files"],
  additionalProperties: false,
  properties: {
    summary: { type: "string", minLength: 5 },
    files: { type: "array", minItems: 1, items: { type: "string" } },
    risks: { type: "array", items: { type: "object", required: ["severity"], properties: { severity: { enum: ["low", "high"] } } } },
  },
};

const ok = (value: unknown) => validateJsonSchema(value, REPORT_SCHEMA);

describe("validateJsonSchema", () => {
  test("accepts a matching object", () => {
    expect(ok({ summary: "all good here", files: ["a.ts"] })).toEqual({ ok: true, issues: [] });
  });

  test("reports a missing required field by name", () => {
    const result = ok({ summary: "enough text" });
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toEqual({ path: "files", message: "is required" });
  });

  test("reports a wrong type at the right path", () => {
    const result = ok({ summary: 42, files: ["a.ts"] });
    expect(result.issues[0].path).toBe("summary");
    expect(result.issues[0].message).toBe("must be a string");
  });

  test("checks nested array items", () => {
    const result = ok({ summary: "enough text", files: ["a.ts"], risks: [{ severity: "medium" }] });
    expect(result.issues[0].path).toBe("risks[0].severity");
    expect(result.issues[0].message).toBe("must be one of \"low\", \"high\"");
  });

  test("enforces minLength, minItems and additionalProperties", () => {
    expect(ok({ summary: "abc", files: ["a.ts"] }).issues[0].path).toBe("summary");
    expect(ok({ summary: "enough text", files: [] }).issues[0].path).toBe("files");
    expect(ok({ summary: "enough text", files: ["a.ts"], extra: 1 }).issues[0].path).toBe("extra");
  });

  test("integer and number are told apart", () => {
    expect(validateJsonSchema(1.5, { type: "integer" }).ok).toBe(false);
    expect(validateJsonSchema(1, { type: "integer" }).ok).toBe(true);
    expect(validateJsonSchema(1.5, { type: "number" }).ok).toBe(true);
  });

  test("a union type accepts any of its options", () => {
    expect(validateJsonSchema("x", { type: ["string", "null"] }).ok).toBe(true);
    expect(validateJsonSchema(null, { type: ["string", "null"] }).ok).toBe(true);
    expect(validateJsonSchema(3, { type: ["string", "null"] }).ok).toBe(false);
  });

  test("a schema-less value is accepted rather than rejected", () => {
    expect(validateJsonSchema({ anything: true }, true).ok).toBe(true);
    expect(validateJsonSchema({ anything: true }, {}).ok).toBe(true);
  });

  test("issues are capped so a bad answer cannot flood the context", () => {
    const result = validateJsonSchema(
      { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 },
      { type: "object", additionalProperties: false, properties: {} },
    );
    expect(result.issues.length).toBeLessThanOrEqual(8);
  });
});

describe("extractJson", () => {
  test("reads plain JSON", () => {
    expect(extractJson('{"a":1}').value).toEqual({ a: 1 });
  });

  test("reads JSON inside a fenced block", () => {
    const text = 'Here is my answer:\n```json\n{"a":1,"b":[2]}\n```\nDone.';
    expect(extractJson(text).value).toEqual({ a: 1, b: [2] });
  });

  test("reads JSON surrounded by prose", () => {
    expect(extractJson('I found this: {"a":1} and that is all.').value).toEqual({ a: 1 });
  });

  test("reads a bare array", () => {
    expect(extractJson("[1,2,3]").value).toEqual([1, 2, 3]);
  });

  test("says so when there is no JSON at all", () => {
    const result = extractJson("I could not finish the task.");
    expect(result.value).toBeUndefined();
    expect(result.error).toBeString();
  });

  test("says so for an empty answer", () => {
    expect(extractJson("   ").error).toBe("the answer was empty");
  });

  test("truncated JSON is an error, not a crash", () => {
    expect(extractJson('{"a": [1, 2').value).toBeUndefined();
  });
});

describe("prompt helpers", () => {
  test("describeSchema is short and readable", () => {
    expect(describeSchema(REPORT_SCHEMA)).toBe(
      '{ summary: string, files: string[], risks?: { severity: "low" | "high" }[] }',
    );
    expect(describeSchema({ type: "string" })).toBe("string");
    expect(describeSchema({ type: "array", items: { type: "number" } })).toBe("number[]");
  });

  test("the instruction carries both the shape and the schema", () => {
    const text = schemaInstruction(REPORT_SCHEMA);
    expect(text).toContain("MUST be a single JSON value");
    expect(text).toContain('"required"');
    expect(text).toContain("No explanation");
  });

  test("the repair message lists every issue with its path", () => {
    const text = repairPrompt([
      { path: "files", message: "is required" },
      { path: "risks[0].severity", message: "must be one of low, high" },
    ]);
    expect(text).toContain("- files: is required");
    expect(text).toContain("- risks[0].severity:");
    expect(text).toContain("only the corrected JSON");
  });
});

describe("normalizeSchemaInput", () => {
  test("an object passes through", () => {
    const schema = { type: "object" };
    expect(normalizeSchemaInput(schema)).toEqual({ schema });
  });

  test("a JSON string is parsed, so validation is not silently skipped", () => {
    expect(normalizeSchemaInput('{"type":"object"}')).toEqual({ schema: { type: "object" } });
  });

  test("no schema stays no schema", () => {
    expect(normalizeSchemaInput(undefined)).toEqual({});
    expect(normalizeSchemaInput("")).toEqual({});
    expect(normalizeSchemaInput(null)).toEqual({});
  });

  test("a broken string is an error, not a pass", () => {
    const result = normalizeSchemaInput("{type: object}");
    expect(result.schema).toBeUndefined();
    expect(result.error).toContain("not valid JSON");
  });

  test("a number or array is refused with a readable message", () => {
    expect(normalizeSchemaInput(5).error).toContain("must be a JSON Schema object");
    expect(normalizeSchemaInput([1, 2]).error).toContain("an array");
  });
});
