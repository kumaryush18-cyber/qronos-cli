import { checkToken, pollForToken, startDeviceFlow, submitConsent, submitUserConsent, UnauthorizedError } from "./auth-flow";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { clearJwt, loadJwt, saveJwt } from "./credentials";
import { CONSENT_VERSION, REPROMPT_CONSENT_TEXT } from "./consent";
import { showIntro } from "./onboarding";
import type { LaunchOptions } from "./pi-launch";
import type { SelfUpdateOutcome } from "./self-update";
import type { ClientVersionCheck } from "./update-check";
import { CLI_VERSION } from "./version";
import { maybeWhatsNew } from "./whats-new";
import { type RunOptions } from "./cli-args";
import { PROVIDER_PRESETS } from "./provider";

export interface RunDeps {
  baseUrl: string;
  agentDir: string;
  credentialsPath: string;
  /** Shows the consent screen, returns true on accept. */
  promptConsent: (text?: string) => Promise<boolean>;
  /** Prompts interactively for API key. */
  promptApiKey?: () => Promise<string>;
  /** Best-effort browser open; must never throw or block. */
  openBrowser: (url: string) => void;
  sleep: (ms: number) => Promise<void>;
  launchPi: (opts: LaunchOptions) => Promise<string | void>;
  log: (message: string) => void;
  /** Startup update check. */
  checkClientVersion: (baseUrl: string, cliVersion: string) => Promise<ClientVersionCheck>;
  /** In-place self-update. */
  maybeSelfUpdate: (action: "notice" | "block", latest: string | undefined) => Promise<SelfUpdateOutcome>;
  /** Required-update relaunch. */
  relaunchLatest?: (latest: string | undefined) => Promise<number | undefined>;
  /** Gravity ad measurement pixel. */
  startGravityPixel?: (jwt: string) => (() => string | undefined) | undefined;
}

/** Runs the full device-flow login (device code -> consent -> poll), stores the JWT. */
async function loginFlow(deps: RunDeps): Promise<string> {
  const device = await startDeviceFlow(deps.baseUrl);
  deps.log(`\nOpen ${device.verification_uri} and enter code: ${device.user_code}\n`);
  deps.openBrowser(device.verification_uri);

  await submitConsent(deps.baseUrl, device.session_id, CONSENT_VERSION);

  const token = await pollForToken(deps.baseUrl, device.session_id, device.interval, deps.sleep);
  await saveJwt(deps.credentialsPath, token);
  return token;
}

function parseSessionArg(argv: readonly string[]): { session?: string; error?: string } {
  const flagIndex = argv.indexOf("--session");
  if (flagIndex === -1) return {};

  const value = argv[flagIndex + 1];
  if (!value || value.startsWith("--")) {
    return { error: "Missing value for --session" };
  }

  try {
    SessionManager.inMemory(process.cwd(), { id: value });
  } catch (err) {
    return { error: `Invalid --session value: ${err instanceof Error ? err.message : String(err)}` };
  }

  return { session: value };
}

export async function run(
  deps: RunDeps,
  argv: readonly string[] = process.argv,
  options: RunOptions = {},
): Promise<number> {
  const sessionArg = parseSessionArg(argv);
  if (sessionArg.error) {
    deps.log(sessionArg.error);
    return 1;
  }

  // 1. Resolve Provider
  const providerKey = (options.provider || "qronos").toLowerCase();
  const preset = PROVIDER_PRESETS[providerKey];
  const isDirectThirdParty = providerKey !== "qronos";

  // 2. Resolve API Key / Credentials
  // Priority: CLI flag -> Provider preset env -> QRONOS_API_KEY -> Stored credentials
  let apiKey =
    options.apiKey ||
    (preset ? process.env[preset.envKey] : undefined) ||
    process.env.QRONOS_API_KEY ||
    process.env.OPENAI_API_KEY ||
    process.env.ANTHROPIC_API_KEY;

  let jwt = apiKey || (await loadJwt(deps.credentialsPath));
  let consentCurrent = Boolean(apiKey || isDirectThirdParty);

  // 3. Resolve Base URL and Model
  const baseUrl = options.baseUrl || (preset && isDirectThirdParty ? preset.baseUrl : deps.baseUrl);
  const selectedModel = options.model || (preset ? preset.defaultModel : undefined);

  // If using Qronos default gateway and no key was passed in env or credentials, run sign-in flow
  if (!jwt && !isDirectThirdParty) {
    const accepted = await deps.promptConsent();
    if (!accepted) {
      deps.log("Declined. Exiting without contacting server.");
      return 1;
    }
    showIntro(deps.log);

    // Interactive key input
    const enteredKey = await deps.promptApiKey?.();
    if (enteredKey) {
      await saveJwt(deps.credentialsPath, enteredKey);
      jwt = enteredKey;
      consentCurrent = true;
      deps.log("✓ API key saved to ~/.qronos/agent/credentials.json\n");
    } else {
      try {
        jwt = await loginFlow(deps);
        consentCurrent = true;
      } catch {
        deps.log("Device login unreached. You can supply an API key directly:");
        deps.log('  export QRONOS_API_KEY="sk_live_..." && qronos-cli');
        return 1;
      }
    }
  }

  // Fallback token for local Ollama without required auth
  if (!jwt && providerKey === "ollama") {
    jwt = "ollama";
    consentCurrent = true;
  }

  if (!jwt) {
    deps.log(`No API key provided for provider "${providerKey}".`);
    deps.log(`Supply a key with:  qronos-cli --api-key <key>  or  export ${preset?.envKey || "QRONOS_API_KEY"}=<key>`);
    return 1;
  }

  // Version & live model catalog check (when using Qronos gateway)
  let updateLatest: string | undefined;
  let versionCheck: ClientVersionCheck = { action: "ok" };
  if (!isDirectThirdParty) {
    try {
      versionCheck = await deps.checkClientVersion(baseUrl, CLI_VERSION);
      if (versionCheck.action !== "ok") {
        const outcome = await deps.maybeSelfUpdate(versionCheck.action, versionCheck.latest);
        if (outcome === "updated-exit") return 0;
        if (outcome === "blocked") {
          const relaunched = await deps.relaunchLatest?.(versionCheck.latest);
          if (relaunched !== undefined) return relaunched;
          deps.log("qronos-cli is below the required minimum version; update with: npm i -g qronos-cli@latest");
          return 1;
        }
        if (outcome === "notice") {
          updateLatest = versionCheck.latest;
        }
      }
      if (versionCheck.notice) deps.log(versionCheck.notice);
    } catch {
      // Offline or network error: continue gracefully
    }
  }

  const whatsNew = maybeWhatsNew(CLI_VERSION, deps.agentDir);
  if (whatsNew) deps.log(whatsNew);

  let getGravityContext: (() => string | undefined) | undefined;
  if (consentCurrent) {
    try {
      getGravityContext = deps.startGravityPixel?.(jwt);
    } catch {
      // Gravity analytics pixel is optional; never stop startup
    }
  }

  const activeModel = selectedModel || versionCheck.model || "claude-sonnet-5.5";
  const catalogModels = versionCheck.models && versionCheck.models.length > 0
    ? versionCheck.models
    : (selectedModel ? [{ id: selectedModel, name: selectedModel }] : undefined);

  const finalSessionId = await deps.launchPi({
    baseUrl,
    jwt,
    agentDir: deps.agentDir,
    session: options.session || sessionArg.session,
    provider: providerKey,
    model: activeModel,
    models: catalogModels,
    fusion: versionCheck.fusion,
    updateLatest,
    getGravityContext,
  });

  deps.log(
    finalSessionId
      ? `\n⚡ Qronos session ended. Resume anytime:  npx qronos-cli --session ${finalSessionId}`
      : "\n⚡ Qronos session ended. Start again anytime:  npx qronos-cli",
  );
  deps.log("(or install globally:  npm i -g qronos-cli  →  qronos-cli)\n");
  return 0;
}
