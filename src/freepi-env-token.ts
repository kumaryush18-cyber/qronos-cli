// A token kept outside the container: `QRONOS_FREEPI_TOKEN`.
//
// Why this exists: a Codespace's home folder can be lost when the container is
// rebuilt, and `~/.qronos/agent/freepi.json` lives there. A Codespaces secret
// (or any environment variable) survives that, so the CLI reads it when the
// file has nothing.
//
// The env token is never written to disk: it already lives somewhere safer, and
// copying it into a file would only make a second place to leak.

import { makeTokenRecord, type FreepiTokenRecord } from "./freepi-tokens";

/** The variable a user can set to keep the token outside the container. */
export const FREEPI_TOKEN_ENV = "QRONOS_FREEPI_TOKEN";

/** Shorter than any real token: a fragment is not a token. */
const MIN_TOKEN_LENGTH = 20;

/**
 * The token from the environment, as a pool record.
 *
 * Undefined when it is missing or too short to be real. The value is never
 * logged and never saved.
 */
export function envTokenRecord(env: Record<string, string | undefined> = process.env): FreepiTokenRecord | undefined {
  const raw = env[FREEPI_TOKEN_ENV]?.trim();
  if (!raw || raw.length < MIN_TOKEN_LENGTH) return undefined;
  const record = makeTokenRecord(raw, [], "env");
  return { ...record, id: "env" };
}
