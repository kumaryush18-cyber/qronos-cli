import { spawn } from "node:child_process";
import { realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { openBrowser } from "./browser";
import { HELP_TEXT, parseCliArgs, versionLine } from "./cli-args";
import { COMPLETION_SHELLS, completionInstallHint, completionScript, isCompletionShell } from "./completions";
import { readAutoUpdate } from "./cli-config";
import { clearJwt, loadJwt } from "./credentials";
import { DEFAULT_BASE_URL, resolveBaseUrl } from "./env";
import { runLogout } from "./logout";
import { runQronosMcp } from "./mcp-command";
import { runFreepi } from "./freepi-cmd";
import { fetchRemoteFreepiTokens, remoteRecords } from "./freepi-remote";
import { runInitCli } from "./init-cmd";
import {
  getConfigPath,
  getConnectionsPath,
  getCredentialsPath,
  getFreepiCatalogPath,
  getFreepiTokensPath,
  getQronosAgentDir,
} from "./paths";
import { loadFreepiCatalog } from "./freepi-catalog";
import { askYesInteractive } from "./freepi-login";
import { clientIdentity } from "./ad-client-headers";
import { CLI_VERSION } from "./version";
import { startGravityPixel } from "./gravity-pixel";
import { startEmailHash } from "./ad-identity";
import { startClientReport } from "./client-report";
import { launchPi } from "./pi-launch";
import { promptApiKeyInteractive, promptConsentInteractive } from "./prompt";
import { createTerminalDeps, runFirstRun } from "./first-run";
import { createRealSpawn } from "./real-spawn";
import { relaunchViaNpx } from "./relaunch";
import { run } from "./run";
import { maybeSelfUpdate } from "./self-update";
import { checkClientVersion } from "./update-check";

/** Resolves symlinks (npm's global bin shim) so the path-boundary check in self-update.ts is meaningful. */
function resolveCliRealpath(): string {
  try {
    return realpathSync(process.argv[1] ?? "");
  } catch {
    // Fail safe: an empty string never matches (or prefixes) a real `npm root -g` path.
    return "";
  }
}

async function main(): Promise<void> {
  // Tell the Qronos admin panel this machine is running the terminal client.
  // Silently does nothing when telemetry is off or no credential is stored.
  startClientReport();
  // Handshake for a parent that relaunched us after a required update: proves
  // the CLI actually started (see relaunch.ts). Best-effort, never fatal.
  if (process.env.QRONOS_RELAUNCH_READY) {
    try {
      writeFileSync(process.env.QRONOS_RELAUNCH_READY, "");
    } catch {}
  }

  // Local commands dispatch before run(): none of these contact the server,
  // so the consent/privacy invariants of the run() flow are never in play.
  const command = parseCliArgs(process.argv.slice(2));
  if (command.kind === "version") {
    console.log(versionLine());
    process.exit(0);
  }
  if (command.kind === "help") {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  if (command.kind === "init") {
    const code = await runInitCli();
    process.exit(code);
  }
  if (command.kind === "completions") {
    if (!isCompletionShell(command.shell)) {
      console.error(`qronos-cli: unsupported shell "${command.shell || "(none)"}". Use one of: ${COMPLETION_SHELLS.join(", ")}`);
      process.exit(2);
    }
    // Script to stdout so it can be redirected; the hint to stderr so it cannot
    // end up inside the sourced file.
    process.stdout.write(completionScript(command.shell));
    console.error(completionInstallHint(command.shell));
    process.exit(0);
  }
  if (command.kind === "unknown") {
    console.error(`qronos-cli: unknown argument "${command.arg}"\n\n${HELP_TEXT}`);
    process.exit(2);
  }
  if (command.kind === "logout") {
    const logoutCode = await runLogout({
      credentialsPath: getCredentialsPath(),
      loadJwt,
      clearJwt,
      log: (message) => console.log(message),
    });
    process.exit(logoutCode);
  }

  if (command.kind === "freepi") {
    const freepiCode = await runFreepi(command.args, {
      path: getFreepiTokensPath(),
      // A fresh login also fills the shared pool, which is the only token
      // source the pool reads. The key comes from the same place every other
      // call uses.
      loadJwt: () => loadJwt(getCredentialsPath()),
      // `list` and `status` read the shared pool, since that is the only place
      // the CLI takes tokens from now.
      loadPool: async () => {
        const result = await fetchRemoteFreepiTokens({
          baseUrl: DEFAULT_BASE_URL,
          jwt: await loadJwt(getCredentialsPath()),
        });
        return result.ok ? remoteRecords(result.tokens) : [];
      },
      log: (line) => console.log(line),
      error: (line) => console.error(line),
      loadCatalog: () => loadFreepiCatalog({ path: getFreepiCatalogPath() }),
      openBrowser: (url) => openBrowser(url),
      confirm: askYesInteractive,
      identity: clientIdentity({ version: CLI_VERSION }),
      baseUrl: DEFAULT_BASE_URL,
    });
    process.exit(freepiCode);
  }

  if (command.kind === "mcp") {
    const mcpCode = await runQronosMcp(command.args, {
      cwd: process.cwd(),
      agentDir: getQronosAgentDir(),
      log: (line) => console.log(line),
      error: (line) => console.error(line),
    });
    process.exit(mcpCode);
  }

  const agentDir = getQronosAgentDir();
  const runOptions = command.kind === "run" ? command.options : {};
  const code = await run(
    {
      baseUrl: resolveBaseUrl(),
      agentDir,
      credentialsPath: getCredentialsPath(agentDir),
      promptConsent: promptConsentInteractive,
      promptApiKey: promptApiKeyInteractive,
      connectionsPath: getConnectionsPath(),
      firstRun: () =>
        runFirstRun(
          createTerminalDeps({
            connectionsPath: getConnectionsPath(),
            // Reuse the real device-flow sign-in so the gateway option behaves
            // exactly like it always did; failure returns to the menu.
            gatewaySignIn: async () => {
              try {
                const { startDeviceFlow, pollForToken, submitConsent } = await import("./auth-flow");
                const { CONSENT_VERSION } = await import("./consent");
                const device = await startDeviceFlow(resolveBaseUrl());
                console.log(`\n  Open ${device.verification_uri} and enter code: ${device.user_code}\n`);
                openBrowser(device.verification_uri);
                await submitConsent(resolveBaseUrl(), device.session_id, CONSENT_VERSION);
                const token = await pollForToken(resolveBaseUrl(), device.session_id, device.interval, (ms) =>
                  new Promise((r) => setTimeout(r, ms)),
                );
                // Stored as a credential, matching the old behaviour.
                const { saveJwt } = await import("./credentials");
                await saveJwt(getCredentialsPath(), token);
                return token;
              } catch {
                return undefined;
              }
            },
          }),
        ),
      openBrowser,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      launchPi,
      log: (message) => console.log(message),
      checkClientVersion,
      startGravityPixel: (jwt, getEmailHash) =>
        startGravityPixel(jwt, join(dirname(agentDir), "gravity"), process.env, undefined, {
          getEmailHash,
          identity: clientIdentity({ version: CLI_VERSION }),
        }),
      // One `/me` read per half hour, in the background. It gives Gravity the
      // hashed email its engine prices on, so a signed-in user earns a real
      // auction instead of the anonymous floor.
      startEmailHash: () =>
        startEmailHash(
          {
            baseUrl: process.env.QRONOS_BASE_URL || DEFAULT_BASE_URL,
            getToken: async () => {
              const token = await loadJwt(getCredentialsPath());
              if (!token) throw new Error("not signed in");
              return token;
            },
          },
          process.env,
        ),
      relaunchLatest: (latest) =>
        relaunchViaNpx(latest, {
          env: process.env,
          argv: process.argv.slice(2),
          platform: process.platform,
          autoUpdateEnabled: () => readAutoUpdate(getConfigPath()),
          spawn: (cmd, args, opts) => spawn(cmd, args, opts),
          proc: process,
          log: (message) => console.log(message),
        }),
      maybeSelfUpdate: (action, latest) =>
        maybeSelfUpdate(action, latest, {
          env: process.env,
          autoUpdateEnabled: () => readAutoUpdate(getConfigPath()),
          spawn: createRealSpawn(),
          cliRealpath: resolveCliRealpath(),
          log: (message) => console.log(message),
        }),
    },
    process.argv,
    runOptions,
  );
  process.exit(code);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
