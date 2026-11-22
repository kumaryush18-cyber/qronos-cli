// One place where a schema is applied, so every path is held to the same test.
//
// The runtime checks an answer against its schema. A restart, a phase rerun and a
// retry do not go through the runtime — they call the agent runner directly — so
// they used to take the runner's `ok` at face value. That was a real bug: an agent
// that failed because its answer did not match came back with a green tick on the
// second try, with nobody having checked the words.
import type { WorkflowAgentResult } from "./workflow-types";
import { extractJson, validateJsonSchema } from "./agent-schema";

/**
 * Make a result obey its schema.
 *
 * `undefined` and `null` schemas mean "no test", so the result is returned as it
 * is. A failed result is left alone: it already has a reason, and replacing a
 * provider error with "schema not satisfied" would hide what went wrong.
 */
export function applySchema(result: WorkflowAgentResult, schema: unknown): WorkflowAgentResult {
  if (schema === undefined || schema === null) return result;
  if (!result.ok) return result;
  const data = result.data ?? extractJson(result.text).value;
  const verdict = validateJsonSchema(data, schema);
  if (verdict.ok) return { ...result, data };
  const detail = verdict.issues
    .slice(0, 3)
    .map((issue) => `${issue.path || "value"} ${issue.message}`)
    .join("; ");
  return { ok: false, text: result.text, data, error: `schema not satisfied: ${detail}` };
}
