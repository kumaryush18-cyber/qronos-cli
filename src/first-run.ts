// First-run setup.
//
// A brand new user types `qronos` with no key and no account. Whatever happens
// next decides whether they stay, so this screen exists to make the first
// thirty seconds obvious and to never dead-end:
//
// 1. Sign in to Qronos Gateway (one account, no key to manage)
// 2. Use my own API key (any OpenAI- or Anthropic-compatible endpoint)
//
// Deliberately only two choices. An earlier draft offered a local-model option
// and a preset provider list; both were noise. A preset list also rots: any
// endpoint speaking the OpenAI wire format works, and that includes every
// provider plus self-hosted servers, so three fields beat a menu that is always
// one release out of date.
//
// Every network call here fails soft. If the gateway is down, the user is
// returned to the menu rather than dropped on an error, because a broken
// backend of ours must never be the end of their first session.

import { createInterface } from "node:readline";
import {
  providerNameFromUrl,
  rememberConnection,
  keyEnvNames,
  type SavedConnection,
} from "./connection-store";
import { describeFetchFailure, fetchModels, type ModelOption } from "./model-fetch";

export interface FirstRunDeps {
  /** Write a line to the user's terminal. */
  log: (message: string) => void;
  /** Read one line. Injected so tests never touch a real stdin. */
  ask: (question: string) => Promise<string>;
  /** Read one line without echoing it (API keys). */
  askSecret: (question: string) => Promise<string>;
  fetchModels?: typeof fetchModels;
  fetchImpl?: typeof fetch;
  /** Where to save a connection. Undefined skips saving. */
  connectionsPath?: string;
  /** Sign in to the gateway; returns a token or undefined on failure. */
  gatewaySignIn: () => Promise<string | undefined>;
  env?: NodeJS.ProcessEnv;
}

export type FirstRunOutcome =
  | { kind: "gateway"; token: string }
  | { kind: "byok"; connection: SavedConnection; apiKey: string }
  | { kind: "quit" };

const BORDER = "────────────────────────────────────────────────────────";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

// Engaging Orange Brand Palette
const ORANGE_BOLD = "\x1b[1;38;2;255;107;0m";
const ORANGE_LIGHT = "\x1b[38;2;255;170;86m";
const WHITE_BOLD = "\x1b[1;37m";
const MUTED = "\x1b[38;2;148;163;184m";
const RESET = "\x1b[0m";

/** The menu, as plain text so it renders identically in any terminal. */
export function renderMenu(selected: number): string {
  const options = [
    {
      title: "Sign in to Qronos Gateway",
      blurb: "One account, no key to manage.",
    },
    {
      title: "Use my own API key",
      blurb: "OpenAI, Anthropic, DeepSeek, Groq, OpenRouter, or any compatible URL.",
    },
  ];

  const lines: string[] = [
    "",
    `  ${ORANGE_BOLD}◈ Qronos CLI${RESET}`,
    "",
    `  ${ORANGE_LIGHT}Welcome. Let's connect you to a model.${RESET}`,
    "",
  ];

  options.forEach((opt, i) => {
    const marker = i === selected ? `${ORANGE_BOLD}❯${RESET}` : " ";
    const num = `${ORANGE_LIGHT}${i + 1}.${RESET}`;
    lines.push(`  ${marker} ${num}  ${WHITE_BOLD}${opt.title}${RESET}`);
    lines.push(`         ${MUTED}${opt.blurb}${RESET}`);
    if (i === 0) lines.push("");
  });

  lines.push("");
  lines.push(`  ${MUTED}Enter a number, or ↑/↓ then ⏎${RESET}`);
  lines.push("");
  return lines.join("\n");
}

/** Header used for the BYOK sub-flow. */
function heading(title: string): string {
  return `\n  ${ORANGE_BOLD}${title}${RESET}\n  ${MUTED}${BORDER}${RESET}\n`;
}

/**
 * Run first-run setup.
 *
 * Returns an outcome the caller applies; this function performs no side effects
 * beyond reading input, calling the network and saving the connection file.
 */
export async function runFirstRun(deps: FirstRunDeps): Promise<FirstRunOutcome> {
  for (;;) {
    deps.log(renderMenu(0));
    const answer = (await deps.ask(`  ${ORANGE_BOLD}❯${RESET} Choice [1-2]: `)).trim().toLowerCase();

    if (answer === "" || answer === "1" || answer === "gateway" || answer === "signin") {
      deps.log(`\n  Opening Qronos Gateway sign-in...\n`);
      let token: string | undefined;
      try {
        token = await deps.gatewaySignIn();
      } catch {
        token = undefined;
      }
      if (token) return { kind: "gateway", token };
      // Never dead-end: a gateway failure returns to the menu.
      deps.log(`  Couldn't complete sign-in (the gateway may be unreachable).\n`);
      deps.log(`  You can try again, or use your own API key instead.\n`);
      continue;
    }

    if (answer === "2" || answer === "byok" || answer === "key") {
      const outcome = await runByok(deps);
      if (outcome) return outcome;
      // Optional step failed or was abandoned: back to the menu.
      continue;
    }

    if (answer === "q" || answer === "quit" || answer === "exit") return { kind: "quit" };

    deps.log(`\n  Not a valid choice. Type 1 or 2.\n`);
  }
}

/**
 * The "use my own API key" flow: three fields, then fetch models, then pick one,
 * then offer to save.
 *
 * Returns undefined when the user backs out, so the caller can show the menu
 * again rather than exiting.
 */
export async function runByok(deps: FirstRunDeps): Promise<FirstRunOutcome | undefined> {
  deps.log(heading("Use your own API key"));

  // 1. Base URL — the only field most people change.
  const rawUrl = (await deps.ask(`  Base URL [${DEFAULT_BASE_URL}]: `)).trim();
  const baseUrl = normaliseBaseUrl(rawUrl || DEFAULT_BASE_URL);
  if (!baseUrl) {
    deps.log(`\n  That doesn't look like a URL. Expected something like ${DEFAULT_BASE_URL}\n`);
    return undefined;
  }

  // 2. Provider name — a label for the footer, not a lookup key.
  const suggested = providerNameFromUrl(baseUrl);
  const rawProvider = (await deps.ask(`  Provider name [${suggested}]: `)).trim();
  const provider = (rawProvider || suggested).toLowerCase().replace(/\s+/g, "-");

  // 3. API key — masked, never echoed, never logged.
  const apiKey = (await deps.askSecret(`  API key: `)).trim();
  if (!apiKey) {
    deps.log(`\n  No key entered. Nothing was saved.\n`);
    return undefined;
  }

  // 4. Fetch the model list, trying every sensible path.
  deps.log(`\n  Checking ${baseUrl} ...`);
  const doFetch = deps.fetchModels ?? fetchModels;
  const result = await doFetch(baseUrl, apiKey, { fetchImpl: deps.fetchImpl });

  if (result.failure === "auth") {
    deps.log(`  ✗ ${describeFetchFailure(result)}\n`);
    return undefined;
  }

  let model: string | undefined;
  if (result.models.length > 0) {
    deps.log(`  ✓ Found ${result.models.length} model${result.models.length === 1 ? "" : "s"}.\n`);
    model = await pickModel(deps, result.models);
    if (!model) return undefined;
  } else {
    // No list is not a failure: some endpoints simply don't publish one.
    deps.log(`  ${describeFetchFailure(result)}\n`);
    const typed = (await deps.ask(`  Model name (e.g. gpt-4o, claude-sonnet-4): `)).trim();
    if (!typed) {
      deps.log(`\n  No model chosen. Nothing was saved.\n`);
      return undefined;
    }
    model = typed;
  }

  const connection: SavedConnection = { baseUrl, provider, model };

  // 5. Offer to save. The key stays out of the file unless explicitly asked.
  if (deps.connectionsPath) {
    const save = (await deps.ask(`\n  Save this connection for next time? [Y/n]: `)).trim().toLowerCase();
    if (save === "" || save === "y" || save === "yes") {
      await rememberConnection(deps.connectionsPath, connection);
      deps.log(`  ✓ Saved to ${deps.connectionsPath}\n`);
      deps.log(`  Your key was not written to disk. Add it to your shell:\n`);
      deps.log(`      export ${keyEnvNames(provider)[0]}='<your key>'\n`);

      const inline = (await deps.ask(`  Store the key on disk instead (mode 0600)? [y/N]: `))
        .trim()
        .toLowerCase();
      if (inline === "y" || inline === "yes") {
        await rememberConnection(deps.connectionsPath, { ...connection, inlineApiKey: apiKey });
        deps.log(`  ✓ Key stored in ${deps.connectionsPath} (readable only by you).\n`);
      }
    } else {
      deps.log(`  Not saved — using it for this session only.\n`);
    }
  }

  return { kind: "byok", connection, apiKey };
}

/** Ask the user to choose from a fetched list; blank keeps the first entry. */
async function pickModel(deps: FirstRunDeps, models: ModelOption[]): Promise<string | undefined> {
  const shown = models.slice(0, 25);
  shown.forEach((m, i) => {
    const label = m.name && m.name !== m.id ? `${m.id}  (${m.name})` : m.id;
    deps.log(`    ${String(i + 1).padStart(2, " ")}. ${label}`);
  });
  if (models.length > shown.length) {
    deps.log(`    ... and ${models.length - shown.length} more (type a name to use one)`);
  }

  const answer = (await deps.ask(`\n  Model [1]: `)).trim();
  if (answer === "") return shown[0]?.id;

  const asIndex = Number(answer);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= shown.length) {
    return shown[asIndex - 1]?.id;
  }

  // Anything else is taken as a model id, so an unlisted model still works.
  return answer;
}

/**
 * Accept what people actually paste: a bare host, a trailing slash, a path.
 * Returns undefined when it cannot form a URL.
 */
export function normaliseBaseUrl(input: string): string | undefined {
  const raw = input.trim();
  if (!raw) return undefined;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (!url.hostname) return undefined;
    return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

/** Build readline-backed helpers for a real terminal. */
export function createTerminalDeps(
  overrides: Omit<FirstRunDeps, "log" | "ask" | "askSecret" | "gatewaySignIn"> &
    Partial<Pick<FirstRunDeps, "gatewaySignIn">> & { gatewaySignIn?: () => Promise<string | undefined> },
): FirstRunDeps {
  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      rl.question(question, (answer) => {
        rl.close();
        resolve(answer);
      });
    });

  const askSecret = (question: string): Promise<string> =>
    new Promise((resolve) => {
      const rl = createInterface({
        input: process.stdin,
        output: process.stdout,
        terminal: true,
      });
      // Suppress echo by overriding the output writer while the user types.
      const anyRl = rl as unknown as { _writeToOutput?: (s: string) => void };
      const original = anyRl._writeToOutput?.bind(rl);
      let muted = false;
      anyRl._writeToOutput = (s: string) => {
        if (muted) return;
        original?.(s);
      };
      rl.question(question, (answer) => {
        rl.close();
        process.stdout.write("\n");
        resolve(answer);
      });
      muted = true;
    });

  return {
    log: (message) => process.stdout.write(`${message}\n`),
    ask,
    askSecret,
    gatewaySignIn: overrides.gatewaySignIn ?? (async () => undefined),
    ...overrides,
  };
}
