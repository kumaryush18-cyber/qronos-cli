// `qronos freepi …`: sign in, list and remove the free-pi tokens.
//
// The easy way is the safe way:
//   login                              admin only: fills the shared pool.
//                                      Nothing is copied out of another app, and
//                                      nothing signs anyone out.
//
// The manual ways are still here:
//   qronos freepi add <token>          typing it, for a quick one-off
//   qronos freepi add -                read from stdin, so it never lands in
//                                      your shell history:
//                                        pbpaste | qronos freepi add - main
//
// Nothing here prints a token. `list` shows a mask like `fp_a…9x2k`, enough to
// recognise a key and never enough to use it.
import { maskToken, type FreepiTokenRecord } from "./freepi-tokens";
import { addFreepiToken, readFreepiStore, removeFreepiToken } from "./freepi-store";
import { adsRequiredText } from "./freepi-ads-source";
import { freepiAdsRequired } from "./freepi-ads-state";
import { catalogSourceText, FREEPI_FALLBACK_IDS, type FreepiCatalogResult } from "./freepi-catalog";
import { FREEPI_ROOT_URL } from "./freepi-models";
import { runFreepiLogin } from "./freepi-login";
import { cliAttribution, inviteUrlFrom } from "./freepi-invite";
import type { ClientIdentity } from "./ad-client-headers";
import { envTokenRecord, FREEPI_TOKEN_ENV } from "./freepi-env-token";
import { postRemoteFreepiToken } from "./freepi-remote";
import { DEFAULT_BASE_URL } from "./env";

export interface FreepiCommandDeps {
  /** `~/.qronos/agent/freepi.json` */
  path: string;
  log: (line: string) => void;
  error: (line: string) => void;
  /** Injected in tests: reads a piped token. */
  readStdin?: () => Promise<string>;
  /** Injected: the model catalogue state, so `status` stays offline and testable. */
  loadCatalog?: () => Promise<FreepiCatalogResult>;
  /** Injected: opens the browser for `login`. */
  openBrowser?: (url: string) => void;
  /** Injected: the consent question. A missing answer means no. */
  confirm?: (question: string) => Promise<boolean>;
  /** What the client reports to free-pi. */
  identity?: ClientIdentity;
  /** Seam for `login`: the network. */
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  deadlineMs?: number;
  /** Injected: the invite link, so a test does not depend on the environment. */
  inviteUrl?: string;
  /** Injected: the environment, for the `QRONOS_FREEPI_TOKEN` fallback. */
  env?: Record<string, string | undefined>;
  /** Injected: what free-pi records about where the account came from. */
  attribution?: { signupSrc?: string; referralCode?: string };
  /**
   * The signed-in qronos key. With it, a fresh login also fills the shared pool,
   * which is the only place the CLI reads tokens from.
   */
  jwt?: string | null;
  /** The qronos gateway base URL. Defaults to the public one. */
  baseUrl?: string;
  /** Seam for `login`: the upload to the shared pool. */
  saveRemote?: typeof postRemoteFreepiToken;
  /** Injected: resolve the qronos key when `jwt` is not passed in. */
  loadJwt?: () => Promise<string | null>;
  /**
   * Injected: the shared pool, for `list` and `status`.
   *
   * The pool is the only token source, so the list must show what the pool
   * really holds, not a leftover file. When this is absent (unit tests, or an
   * old call site) the saved file is shown and labelled as such.
   */
  loadPool?: () => Promise<FreepiTokenRecord[]>;
}

export const FREEPI_USAGE = [
  "Usage:",
  "  qronos freepi list                     show the saved tokens (masked)",
  "  qronos freepi status                   tokens, ads and the model catalogue",
  "  qronos freepi add <token> [label]      add a token",
  "  qronos freepi add - [label]            add a token read from stdin",
  "  qronos freepi remove <id|label>        remove a token",
  "",
  "One key = one request at a time, because that is the upstream rule.",
].join("\n");

async function defaultReadStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString("utf8");
}

/** One readable row per token. Never the secret. */
export function formatTokenRows(records: readonly FreepiTokenRecord[], now = Date.now()): string[] {
  if (records.length === 0) {
    return ["The shared pool is empty, so the free models are unavailable right now."];
  }
  const rows = records.map((record) => {
    const left = Math.max(0, Math.ceil(((record.coolDownUntil ?? 0) - now) / 1000));
    const state = left > 0 ? `cooling down ${left}s` : "ready";
    return `${record.id}  ${(record.label ?? "-").padEnd(10)} ${maskToken(record.token).padEnd(12)} ${state}`;
  });
  return [`${records.length} token${records.length === 1 ? "" : "s"} · one request at a time each`, ...rows];
}

export async function runFreepi(args: readonly string[], deps: FreepiCommandDeps): Promise<number> {
  const [action, ...rest] = args;

  if (action === undefined || action === "help" || action === "--help") {
    deps.log(FREEPI_USAGE);
    return 0;
  }

  if (action === "list") {
    const store = await readFreepiStore(deps.path);
    const shared = deps.loadPool ? await deps.loadPool() : undefined;
    if (shared) {
      // The pool is the only source, so a stale local file is not shown as if it
      // were in use. An empty pool says so plainly.
      if (shared.length === 0) {
        deps.log("The shared pool is empty, so the free models are unavailable right now.");
      } else {
        for (const line of formatTokenRows(shared)) deps.log(line);
        deps.log("source: shared pool (qronos-ai admin panel)");
      }
      const warning = adsRequiredText(freepiAdsRequired());
      if (warning) deps.log(warning);
      return 0;
    }
    // A token kept in the environment (a Codespaces secret, for example) is a
    // real token, so say where it came from instead of "no tokens saved yet".
    const fromEnv = store.tokens.length === 0 ? envTokenRecord(deps.env) : undefined;
    if (fromEnv) {
      deps.log("1 token · one request at a time each");
      deps.log(`${FREEPI_TOKEN_ENV}  env        ${maskToken(fromEnv.token)} ready (not saved to disk)`);
    } else {
      for (const line of formatTokenRows(store.tokens)) deps.log(line);
    }
    const warning = adsRequiredText(freepiAdsRequired());
    if (warning) deps.log(warning);
    return 0;
  }

  if (action === "status") {
    const store = await readFreepiStore(deps.path);
    const shared = deps.loadPool ? await deps.loadPool() : undefined;
    if (shared) {
      for (const line of formatTokenRows(shared)) deps.log(line);
      deps.log(shared.length > 0 ? "source: shared pool (qronos-ai admin panel)" : "source: shared pool, empty");
    } else {
      for (const line of formatTokenRows(store.tokens)) deps.log(line);
    }
    const warning = adsRequiredText(freepiAdsRequired());
    if (warning) deps.log(warning);
    // The catalogue is read, not fetched: `status` must answer quickly and
    // must never need the network to tell you what you already have.
    const catalog = await deps.loadCatalog?.();
    if (catalog) deps.log(catalogSourceText(catalog));
    else deps.log(`models: ${FREEPI_FALLBACK_IDS.length} free models (catalogue not read)`);
    return 0;
  }

  if (action === "login") {
    const label = rest[0];
    const result = await runFreepiLogin({
      baseUrl: FREEPI_ROOT_URL,
      open: deps.openBrowser ?? (() => {}),
      log: deps.log,
      // No confirm function means no yes, and no yes means nothing is saved.
      confirm: deps.confirm ?? (async () => false),
      fetchImpl: deps.fetchImpl,
      sleep: deps.sleep,
      deadlineMs: deps.deadlineMs,
      identity: deps.identity,
      // The invite link the owner chose; `QRONOS_FREEPI_INVITE` overrides it.
      inviteUrl: deps.inviteUrl ?? inviteUrlFrom(),
      attribution: deps.attribution ?? cliAttribution(),
    });
    if (!result.ok) {
      deps.error(result.reason);
      return 1;
    }
    const saved = await addFreepiToken(deps.path, result.token, label ?? "github");
    if (saved.duplicate) {
      deps.log(`That account is already saved as ${saved.record.id}. Nothing was added.`);
    } else {
      deps.log(`Signed in. Saved ${saved.record.id} (${saved.record.label ?? "github"}) as ${maskToken(result.token)}.`);
    }

    // Then the shared pool, which is the only source the CLI reads from. This
    // upload is best effort on purpose: a login must never fail because the
    // upload failed, so every outcome is one plain line and the exit code stays 0.
    const jwt = deps.jwt !== undefined ? deps.jwt : await (deps.loadJwt ? deps.loadJwt() : Promise.resolve(null));
    const upload = deps.saveRemote ?? postRemoteFreepiToken;
    const shared = await upload(result.token, { baseUrl: deps.baseUrl ?? DEFAULT_BASE_URL, jwt });
    if (shared.ok) {
      const tail = shared.fingerprint ? ` · •••${shared.fingerprint}` : "";
      const slot = `slot ${shared.slot + 1}`;
      deps.log(
        shared.duplicate
          ? `Already in the shared pool · ${slot}${tail}`
          : `Saved to the shared pool · ${slot}${tail}`,
      );
    } else {
      deps.log(`Not in the shared pool yet. ${shared.message}`);
    }
    return 0;
  }

  if (action === "add") {
    const raw = rest[0];
    if (raw === undefined) {
      deps.error("Which token? Usage: qronos freepi add <token> [label]\n(or `qronos freepi add -` to read it from stdin)");
      return 2;
    }
    let token = raw;
    if (raw === "-") {
      const read = deps.readStdin ?? defaultReadStdin;
      token = await read();
    }
    if (token.trim() === "") {
      deps.error("The token was empty. Nothing was saved.");
      return 2;
    }
    const label = rest[1];
    const result = await addFreepiToken(deps.path, token, label);
    if (result.duplicate) {
      deps.log(`That token is already saved as ${result.record.id}${result.record.label ? ` (${result.record.label})` : ""}. Nothing was added.`);
      return 0;
    }
    deps.log(
      `Saved ${result.record.id}${result.record.label ? ` (${result.record.label})` : ""} as ${maskToken(result.record.token)}.`,
    );
    const store = await readFreepiStore(deps.path);
    deps.log(`${store.tokens.length} token${store.tokens.length === 1 ? "" : "s"} now in the pool. Stored in ${deps.path} (mode 600).`);
    return 0;
  }

  if (action === "remove") {
    const word = rest[0];
    if (word === undefined) {
      deps.error("Which one? Usage: qronos freepi remove <id|label>   (see: qronos freepi list)");
      return 2;
    }
    const result = await removeFreepiToken(deps.path, word);
    if (!result.removed) {
      const known = result.known.length > 0 ? result.known.join(", ") : "(none saved)";
      deps.error(`No token called "${word}". Saved: ${known}`);
      return 2;
    }
    deps.log(`Removed ${result.removed.id}${result.removed.label ? ` (${result.removed.label})` : ""}. ${result.remaining} left.`);
    return 0;
  }

  deps.error(`Unknown action "${action}".\n\n${FREEPI_USAGE}`);
  return 2;
}
