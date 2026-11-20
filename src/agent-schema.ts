// Part B of the Agent Hub: typed subagent results.
//
// A subagent that answers in prose forces the parent to read that prose and
// guess at its structure — and a wrong guess is a silent bug. When the caller
// supplies an `output_schema`, the subagent must answer with JSON that matches
// it, and the parent receives the parsed value.
//
// This is a small, dependency-free JSON Schema validator. It covers the shapes
// that matter for subagent reports (objects, arrays, strings, numbers, booleans,
// null, enums, required fields, nested objects) and ignores annotations it does
// not use, instead of pulling in a 100 KB validator that would then need its own
// audit.
//
// The same rules are enforced twice: once as an instruction in the subagent's
// prompt, and once here. The prompt is a request, this file is the check.

export interface SchemaIssue {
  /** Where the problem is, e.g. "risks[1].severity". Empty for the root. */
  path: string;
  message: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: SchemaIssue[];
}

const MAX_REPORTED_ISSUES = 8;

/**
 * Normalise the schema a caller passed.
 *
 * Models often send the schema as a JSON *string* even when the tool declares an
 * object. Treating that as "no schema" would turn validation off silently, which
 * is the one failure this whole file exists to prevent, so a string is parsed and
 * anything that is not a schema is refused.
 */
export function normalizeSchemaInput(value: unknown): { schema?: unknown; error?: string } {
  if (value === undefined || value === null) return {};
  if (typeof value === "boolean") return { schema: value };
  if (typeof value === "string") {
    const text = value.trim();
    if (text === "") return {};
    try {
      const parsed = JSON.parse(text);
      return normalizeSchemaInput(parsed);
    } catch {
      return { error: "output_schema is a string but not valid JSON. Pass a JSON Schema object." };
    }
  }
  if (typeof value === "object" && !Array.isArray(value)) return { schema: value };
  return { error: `output_schema must be a JSON Schema object, got ${Array.isArray(value) ? "an array" : typeof value}.` };
}

/** Validate a value against a JSON Schema subset. */
export function validateJsonSchema(value: unknown, schema: unknown, path = ""): ValidationResult {
  const issues: SchemaIssue[] = [];
  check(value, schema, path, issues, 0);
  return { ok: issues.length === 0, issues: issues.slice(0, MAX_REPORTED_ISSUES) };
}

function check(value: unknown, schema: unknown, path: string, issues: SchemaIssue[], depth: number): void {
  if (issues.length >= MAX_REPORTED_ISSUES || depth > 24) return;
  if (schema === true || schema === undefined || schema === null) return;
  if (typeof schema !== "object") return;
  const spec = schema as Record<string, unknown>;

  if (Array.isArray(spec.enum)) {
    const allowed = spec.enum as unknown[];
    if (!allowed.some((item) => deepEqual(item, value))) {
      issues.push({
        path,
        message: `must be one of ${allowed.map((item) => JSON.stringify(item)).join(", ")}`,
      });
      return;
    }
  }

  const type = spec.type;
  if (typeof type === "string" && !matchesType(value, type)) {
    issues.push({ path, message: `must be a ${type}` });
    return;
  }
  if (Array.isArray(type)) {
    const options = type.filter((item): item is string => typeof item === "string");
    if (options.length > 0 && !options.some((option) => matchesType(value, option))) {
      issues.push({ path, message: `must be a ${options.join(" or ")}` });
      return;
    }
  }

  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    if (typeof spec.minLength === "number" && value.length < spec.minLength) {
      issues.push({ path, message: `must be at least ${spec.minLength} characters` });
    }
    if (typeof spec.pattern === "string") {
      try {
        if (!new RegExp(spec.pattern).test(value)) {
          issues.push({ path, message: `must match ${spec.pattern}` });
        }
      } catch {
        // An invalid pattern is the caller's mistake, not the answer's.
      }
    }
  }

  if (typeof value === "number") {
    if (typeof spec.minimum === "number" && value < spec.minimum) {
      issues.push({ path, message: `must be >= ${spec.minimum}` });
    }
    if (typeof spec.maximum === "number" && value > spec.maximum) {
      issues.push({ path, message: `must be <= ${spec.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (typeof spec.minItems === "number" && value.length < spec.minItems) {
      issues.push({ path, message: `must have at least ${spec.minItems} items` });
    }
    if (typeof spec.maxItems === "number" && value.length > spec.maxItems) {
      issues.push({ path, message: `must have at most ${spec.maxItems} items` });
    }
    if (spec.items !== undefined) {
      value.forEach((item, index) => check(item, spec.items, join(path, `[${index}]`), issues, depth + 1));
    }
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const object = value as Record<string, unknown>;
    const properties = (spec.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(spec.required) ? (spec.required as string[]) : [];
    for (const key of required) {
      if (object[key] === undefined) issues.push({ path: join(path, key), message: "is required" });
    }
    for (const [key, childSchema] of Object.entries(properties)) {
      if (object[key] !== undefined) check(object[key], childSchema, join(path, key), issues, depth + 1);
    }
    if (spec.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!(key in properties)) issues.push({ path: join(path, key), message: "is not allowed here" });
      }
    }
  }
}

function join(path: string, key: string): string {
  if (key.startsWith("[")) return `${path}${key}`;
  return path ? `${path}.${key}` : key;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (typeof a === "object") return JSON.stringify(a) === JSON.stringify(b);
  return false;
}

/**
 * Pull a JSON object or array out of a model answer.
 *
 * Models wrap JSON in ```json fences, add a sentence before it, or both. Being
 * strict here would fail answers that are perfectly usable.
 */
export function extractJson(text: string): { value?: unknown; error?: string } {
  const trimmed = text.trim();
  if (trimmed === "") return { error: "the answer was empty" };

  const candidates: string[] = [];
  const fenced = /```(?:json|jsonc)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  candidates.push(trimmed);

  // Last resort: the outermost {...} or [...] in the text.
  const firstBrace = Math.min(
    ...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((index) => index >= 0),
  );
  if (Number.isFinite(firstBrace) && firstBrace >= 0) {
    const slice = trimmed.slice(firstBrace);
    candidates.push(slice);
    const lastBrace = Math.max(slice.lastIndexOf("}"), slice.lastIndexOf("]"));
    if (lastBrace > 0) candidates.push(slice.slice(0, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return { value: JSON.parse(candidate) };
    } catch {
      // Try the next candidate.
    }
  }
  return { error: "the answer is not valid JSON" };
}

/** One short sentence describing the expected shape, for the prompt. */
export function describeSchema(schema: unknown, depth = 0): string {
  if (depth > 3 || typeof schema !== "object" || schema === null) return "any value";
  const spec = schema as Record<string, unknown>;
  if (Array.isArray(spec.enum)) return spec.enum.map((item) => JSON.stringify(item)).join(" | ");
  const type = spec.type;
  if (type === "array") {
    return `${describeSchema(spec.items, depth + 1)}[]`;
  }
  if (type === "object") {
    const properties = (spec.properties ?? {}) as Record<string, unknown>;
    const required = Array.isArray(spec.required) ? (spec.required as string[]) : [];
    const parts = Object.entries(properties).map(([key, child]) => {
      const mark = required.includes(key) ? "" : "?";
      return `${key}${mark}: ${describeSchema(child, depth + 1)}`;
    });
    return `{ ${parts.join(", ")} }`;
  }
  return typeof type === "string" ? type : "any value";
}

/** The instruction added to a subagent's prompt when a schema is required. */
export function schemaInstruction(schema: unknown): string {
  return [
    "## Required output format",
    `Your final answer MUST be a single JSON value matching this schema: ${describeSchema(schema)}`,
    "Output the JSON only. No explanation, no markdown before or after it.",
    `Schema: ${JSON.stringify(schema)}`,
  ].join("\n");
}

/** The message sent back to a subagent whose answer did not match. */
export function repairPrompt(issues: SchemaIssue[]): string {
  const list = issues.map((issue) => `- ${issue.path || "(root)"}: ${issue.message}`).join("\n");
  return [
    "Your last answer did not match the required JSON schema:",
    list,
    "Reply again with only the corrected JSON value. No prose, no fences.",
  ].join("\n");
}
