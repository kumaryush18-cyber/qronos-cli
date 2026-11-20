import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  InteractiveMode,
  SessionManager,
  SettingsManager,
  UserMessageComponent,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { createAdsExtension } from "@qronos/pi-ads";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProviderConfig, MODEL_ID, PROVIDER_NAME, SAFE_TOOLS, type CatalogModel } from "./provider";
import { createUsageToolExtension, USAGE_TOOL_NAME } from "./usage-tool";
import { createImageToolExtension, IMAGE_TOOL_NAME } from "./image-tool";
import { createWebToolsExtension, DOCS_LOOKUP_TOOL_NAME, WEB_SEARCH_TOOL_NAME } from "./web-tools";
import { createBuyToolExtension, BUY_TOOL_NAME } from "./buy-tool";
import { createDocsToolExtension, DOCS_TOOL_NAME } from "./docs-tool";
import { createTodoToolExtension, TODO_TOOL_NAME } from "./todo-tool";
import { createExitPlanToolExtension, EXIT_PLAN_TOOL_NAME, ENTER_PLAN_TOOL_NAME } from "./exit-plan-tool";
import { createAgentToolExtension, AGENT_TOOL_NAME } from "./agent-tool";
import { AgentRegistry } from "./agent-registry";
import { createAgentHubExtension } from "./agent-hub";
import { createFileCompletionExtension } from "./file-completion-extension";
import { createToolAliasesExtension } from "./tool-aliases";
import { createErrorNoticeExtension } from "./error-notice";
import { createWorkingLineExtension } from "./working-line";
import { ensureKeybindingDefaults } from "./keybindings";
import { ensureUiDefaults, installSmoothScrolling } from "./ui-defaults";
import { resolveTuiMode } from "./env";
import { AGENT_RULES } from "./agent-rules";
import { loadMemoryPrompt } from "./memory-io";
import { getUserMemoryPath } from "./paths";
import { createToolGuardExtension } from "./tool-guard";
import { installBugHandler } from "./bug-report";
import { createAdvisorExtension } from "./advisor";
import { parseAdvisorConfig } from "./advisor-core";
import { createStreamRulesExtension, defaultRulePaths } from "./stream-rules-extension";
import { createNotifyExtension } from "./notify-extension";
import { notificationsEnabled } from "./notifications";
import { installFrameRateCap } from "./frame-rate";
import { createPatchToolExtension, PATCH_TOOL_NAME } from "./hashline/tool";
import { createLspToolExtension, LSP_TOOL_NAME } from "./lsp/tool";
import { installEffortHandler } from "./effort-selector";
import { installFooterRightAlign } from "./footer-align";
import { readConfigObject, readHooksFile, readStatusLineCommand, writeConfigPatch } from "./cli-config";
import { getConfigPath, getHooksPath, getProjectHooksPath } from "./paths";
import { createHooksExtension } from "./hooks-extension";
import { mergeHookConfigs, parseHookConfig } from "./hooks";
import { initExecutionMode, isExecutionMode, setExecutionModePersistence } from "./execution-modes";
import { createCommandsExtension } from "./commands";
import { createHeaderExtension } from "./header";
import { resolveQronosScope } from "./provider-lock";
import { createFusionExtension, resolveFusionIds } from "./fusion";
import { patchResumeLine } from "./resume-line";
import { CLAUDE_THEME_NAME, ensureQronosTheme } from "./theme-claude";
import { createClaudeToolRendererExtension } from "./tool-renderer-claude";
import { createPromptHistoryExtension } from "./interrupt-handler";
import { decideProjectTrustInteractive, projectTrustForCwd } from "./project-trust";
import { DEFAULT_BASE_URL } from "./env";

export interface LaunchOptions {
  baseUrl: string;
  jwt: string;
  agentDir: string;
  session?: string;
  /** Custom provider name (qronos, openai, anthropic, deepseek, ollama). */
  provider?: string;
  /** Server-reported active model to display (falls back to MODEL_ID). */
  model?: string;
  /** #140: the selectable model catalog from /client-version. When present the
   * picker offers all of them; empty/absent falls back to the single `model`. */
  models?: CatalogModel[];
  /** Server-chosen Fusion planner/executor ids (from /client-version). */
  fusion?: { planner: string; executor: string };
  /** A newer qronos-cli version, when /client-version reported one and the
   * self-update fell back to notifying. Renders the header's update banner —
   * qronos's replacement for pi's own (suppressed) `pi update` banner. */
  updateLatest?: string;
  /** Base64url Gravity context for the ads extension's /ads/next header; undefined when the pixel is off or not ready. */
  getGravityContext?: () => string | undefined;
  dangerouslySkipPermissions?: boolean;
  /**
   * Whether the current folder's project resources (.pi/mcp.json, .pi/extensions,
   * .pi/settings.json, .agents/skills) may load. launchPi() decides this before
   * the TUI starts (project-trust.ts). Absent means untrusted: pi's SettingsManager
   * would otherwise default to trusted.
   */
  projectTrusted?: boolean;
}

/** The models to register + scope the picker to: the server catalog when it
 * sent one, else the single active model (back-compat with a plain response). */
function catalogModelsFor(opts: LaunchOptions): CatalogModel[] {
  if (opts.models && opts.models.length > 0) return opts.models;
  const id = opts.model || MODEL_ID;
  return [{ id, name: id }];
}

// the exact, closed set of tool names the shipped distro ever
// legitimately runs — SAFE_TOOLS' built-ins, the registered custom tools
// (qronos_usage, U5; qronos_buy_credits, #226; qronos_docs; todo), and
// pi's `codemode` and `tool_search` (2026-10-13, user-added MCP servers). MCP
// tools themselves (`mcp__<server>__<tool>` and the three MCP resource tools)
// are not listed: the user picks those servers, and tool-guard.ts admits them
// by name shape. Used two ways, belt
// and bracesfound `defaultTools` alone does not block an
// extension-registered tool):
// 1. Passed as `tools` to createAgentSessionFromServices — the SDK's own
// strict allowlist (docs/settings.md: same mechanism as the CLI's
// `--tools` flag, "only the listed tool names are enabled").
// 2. Passed to the tool-guard extension, which blocks + reports anything
// outside this set that still somehow reaches a tool_call event.
export const ALLOWED_TOOL_NAMES: readonly string[] = [
  ...SAFE_TOOLS,
  USAGE_TOOL_NAME,
  BUY_TOOL_NAME,
  DOCS_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  DOCS_LOOKUP_TOOL_NAME,
  IMAGE_TOOL_NAME,
  TODO_TOOL_NAME,
  ENTER_PLAN_TOOL_NAME,
  EXIT_PLAN_TOOL_NAME,
  AGENT_TOOL_NAME,
  // Hashline edits and language-server actions. Both are registered by our own
  // extensions, so they need an explicit entry here as well as in defaultTools.
  PATCH_TOOL_NAME,
  LSP_TOOL_NAME,
  "codemode",
  "tool_search",
];

/**
 * The SDK `tools` list: ALLOWED_TOOL_NAMES plus the MCP tool patterns. pi never
 * declares an MCP tool that no entry names or matches, so without these a
 * user server with `"exposure": "direct"` (or a direct `toolExposure`) would
 * have no tools declared. Servers on the default codemode exposure stay
 * undeclared either way. The guard still admits the same names (tool-guard.ts).
 */
export const SDK_TOOLS: readonly string[] = [
  ...ALLOWED_TOOL_NAMES,
  "mcp__*",
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
];

/** Bundled skills. From src/ or from the built dist/ the folder is one level up. */
export const SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");

export interface RuntimeBuildOptions {
  settingsManager: SettingsManager;
  resourceLoaderOptions: {
    extensionFactories: InlineExtension[];
    additionalSkillPaths: string[];
    appendSystemPromptOverride: (base: string[]) => string[];
  };
  /** Names of every extension this distro will load — the property SB1's structural test asserts on. */
  extensionNames: string[];
  tools: readonly string[];
}

/**
 * Pure construction of the pi runtime qronos-cli ships: which extensions
 * load, which tools are enabled, and the settings pinning `packages: []`
 * (no pi-package registry, so no subagent package can be pulled in). Extracted from launchPi() as a test seam (#28 SB1) —
 * launchPi() itself drives the real interactive TUI and is only exercised
 * when the bin actually runs, never in `bun test`.
 */
/**: the display model name for the header — server catalog name, then
 * the active model id, then the built-in default. Exported as a test seam. */
export function resolveModelName(opts: LaunchOptions): string {
  return opts.models?.[0]?.name || opts.model || MODEL_ID;
}

/**
 * The in-memory settings, with trust for one folder. `projectTrusted` gates
 * every project resource pi would load from that folder (.pi/mcp.json,
 * .pi/extensions, .pi/settings.json, skills); pi defaults it to true, so it is
 * always passed explicitly.
 */
export function buildSettingsManager(opts: LaunchOptions, models: CatalogModel[], projectTrusted: boolean): SettingsManager {
  const providerName = opts.provider || PROVIDER_NAME;
  return SettingsManager.inMemory(
    {
      defaultProvider: providerName,
      // The picker starts on the first catalog model (the server lists the
      // default first); the user switches with /model.
      defaultModel: models[0]!.id,
      defaultTools: [
        ...SAFE_TOOLS,
        TODO_TOOL_NAME,
        EXIT_PLAN_TOOL_NAME,
        AGENT_TOOL_NAME,
        // Hashline edits and language-server actions (QRONOS_HASHLINE=0 removes the tool).
        PATCH_TOOL_NAME,
        LSP_TOOL_NAME,
      ],
      packages: [],
      // hides pi's own startup header dump so qronos-header is the only header shown.
      quietStartup: true,
      // fullscreen by default: the terminal only reports mouse clicks in the
      // alternate screen, and clicks in the input box move the cursor there
      // (pi-tui Editor.handleMouse). QRONOS_TUI_MODE=regular restores the old
      // inline mode, where clicks are left to the terminal's own selection.
      tuiMode: resolveTuiMode(),
      // Erase rows the autocomplete panel no longer needs. Without this the
      // @ file list stays painted after the '@' is deleted until the next key
      // press redraws (pi's default is off; it exists for terminals that
      // cannot move the cursor).
      terminal: { clearOnShrink: true },
      theme: CLAUDE_THEME_NAME,
      enableInstallTelemetry: false,
    },
    { projectTrusted },
  );
}

/** Settings for one runtime: pi calls the runtime factory per folder (resume, new, fork, tree). */
export function settingsForRuntime(
  opts: LaunchOptions,
  rtCwd: string,
  launch: { cwd: string; trusted: boolean },
): SettingsManager {
  return buildSettingsManager(opts, catalogModelsFor(opts), projectTrustForCwd(rtCwd, launch, opts.agentDir));
}

export function buildRuntimeOptions(opts: LaunchOptions, sessionId: string): RuntimeBuildOptions {
  // Point it at qronos agent dir so user servers live in ~/.qronos/agent/mcp.json.
  process.env.PI_CODING_AGENT_DIR = opts.agentDir;
  const models = catalogModelsFor(opts);
  const providerName = opts.provider || PROVIDER_NAME;
  const providerExtension: InlineExtension = {
    name: "qronos-provider",
    factory: (qronos: ExtensionAPI) => {
      qronos.registerProvider(
        providerName,
        buildProviderConfig({
          providerName,
          baseUrl: opts.baseUrl,
          apiKey: opts.jwt,
          sessionId,
          modelId: opts.model,
          models,
        }),
      );
    },
  };

  // the only channel /support has to the currently-shown banner ad's
  // click URL — set by the ads extension's onBannerAd, read by the commands
  // extension's getAdvertiserUrl. Deliberately not a shared object/class:
  // one field, one file, both extensions stay independently testable.
  let advertiserUrl: string | undefined;

  // banner/inline ads + usage meter, sandboxed to UI-only hooks.
  // See packages/pi-ads/src/sandbox.test.ts for the enforced proof.
  const adsBaseUrl = process.env.QRONOS_BASE_URL || DEFAULT_BASE_URL;
  const adsExtension: InlineExtension = createAdsExtension({
    baseUrl: adsBaseUrl,
    getToken: () => opts.jwt,
    sessionId,
    getGravityContext: opts.getGravityContext,
    onBannerAd: (u) => {
      advertiserUrl = u;
    },
  });

  // read-only "what's my usage" tool. Outside packages/pi-ads on
  // purpose — see usage-tool.ts's header comment.
  const usageToolExtension: InlineExtension = createUsageToolExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
  });

  // opens the server's buy-credits page. Outside packages/pi-ads on
  // the same grounds as the usage tool — see buy-tool.ts's header
  // comment.
  const buyToolExtension: InlineExtension = createBuyToolExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
  });

  // (2026-09-03): read-only "about qronos" docs tool. Outside
  // packages/pi-ads on the same grounds as the usage/buy tools —
  // see docs-tool.ts's header comment.
  const docsToolExtension: InlineExtension = createDocsToolExtension();

  // web_search + docs_lookup: server-executed, metered against the daily allowance.
  const webToolsExtension: InlineExtension = createWebToolsExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
  });

  // generate_image: server-generated, saved under <cwd>/images/, metered like web tools.
  const imageToolExtension: InlineExtension = createImageToolExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
  });

  // 2026-09-01: one readable, server-owned line when a turn is rejected
  // (read from turn_end's error envelope). See error-notice.ts.
  const errorNoticeExtension: InlineExtension = createErrorNoticeExtension();

  // 2026-11-20: Claude-Code-style working line ("✢ Crafting… (32s · ↓ 1.2k
  // tokens · thinking)"). It is a widget above the editor, so it sits outside
  // the input border and above the ad box, and it counts output tokens for the
  // whole run (prompt -> final answer), not per model call. No tool, no model
  // call of its own.
  const workingLineExtension: InlineExtension = createWorkingLineExtension();

  // defense-in-depth block + report for any tool outside
  // ALLOWED_TOOL_NAMES that somehow reaches a tool_call event.
  const toolGuardExtension: InlineExtension = createToolGuardExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
    allowedTools: ALLOWED_TOOL_NAMES,
  });

  // 0.2.6: qronos's slash commands — /close-other-session, /whats-new, /update.
  // A dedicated extension rather than folding into usage-tool (which stays
  // read-only).
  const commandsExtension: InlineExtension = createCommandsExtension({
    baseUrl: opts.baseUrl,
    getToken: () => opts.jwt,
    apiKey: opts.jwt,
    provider: opts.provider,
    model: opts.model,
    getAdvertiserUrl: () => advertiserUrl,
  });

  // (2026-09-03): qronos's own startup header, replacing pi's
 // built-in one (hidden via quietStartup below).,.
  const headerExtension: InlineExtension = createHeaderExtension({
    modelName: resolveModelName(opts),
    updateLatest: opts.updateLatest,
  });

  // 2026-10-13: a task list for the model, and pi's own MCP support so users
  // can add their own MCP servers (`qronos-cli mcp add`, ~/.qronos/agent/mcp.json).
  // The pi factories are bare functions with no name, so wrap them to keep
  // extensionNames stable. qronos bundles no MCP servers. Codemode runs with
  // `models: false`: scripts get no `models` global, so a script can never
  // start a model request of its own (one agent per user, SB2).
  const todoToolExtension: InlineExtension = createTodoToolExtension();
  // Tier 1 item 2: plan mode's ExitPlanMode tool. It is refused outside plan
  // mode (see exit-plan-tool.ts), so it cannot be used to skip review.
  const exitPlanToolExtension: InlineExtension = createExitPlanToolExtension({});
  // Tier 2 item 7: Subagent tool with Option B read-only start and plan approval gate.
  // One registry for the session: the tool writes it, the Hub panel reads it.
  const agentRegistry = new AgentRegistry();
  const agentToolExtension: InlineExtension = createAgentToolExtension({ registry: agentRegistry });
  // Agent Hub: floating roster on Alt+A or /agents. It only mirrors the
  // registry — approvals stay in the main chat.
  const agentHubExtension = createAgentHubExtension({ registry: agentRegistry }) as InlineExtension;
  // Tier 3 item 9: @file completion fallback for when fd is unavailable.
  const fileCompletionExtension: InlineExtension = createFileCompletionExtension();
  // Hashline edits (ported from can1357/oh-my-pi): `apply_patch` edits by line
  // range from a tagged read, so a 3-line change to a 400-line file costs 3 lines
  // of output instead of 30. `edit` stays available too — QRONOS_HASHLINE=0
  // removes both the tool and the numbered reads.
  const hashlineEnabled = (process.env.QRONOS_HASHLINE ?? "1").trim() !== "0";
  const patchToolExtension: InlineExtension = {
    name: "qronos-apply-patch",
    factory: createPatchToolExtension({ numberReads: hashlineEnabled }),
  };
  // Language server: rename symbols and move files so imports follow.
  const lspToolExtension: InlineExtension = {
    name: "qronos-lsp",
    factory: createLspToolExtension({ cwd: () => process.cwd() }),
  };
  // Ported from can1357/oh-my-pi. Both are OFF when unconfigured, so the closed
  // extension list below does not grow for users who never asked for them.
  //   advisor:      a cheap reviewer model reads each finished turn
  //   stream rules: stop a turn the moment a banned pattern is streamed
  const advisorConfig = parseAdvisorConfig(process.env as Record<string, string | undefined>);
  const advisorExtension = createAdvisorExtension({ config: advisorConfig });
  const streamRulesRuntime = createStreamRulesExtension({
    ...defaultRulePaths(process.cwd(), opts.agentDir),
  });
  if (streamRulesRuntime.warnings.length > 0) {
    for (const warning of streamRulesRuntime.warnings) console.error(`qronos-cli: ${warning}`);
  }
  // Registered even with zero rules: the factory returns immediately, so an
  // empty rule file costs nothing and the extension list stays predictable.
  const streamRulesExtension: InlineExtension = {
    name: "qronos-stream-rules",
    factory: streamRulesRuntime.extension,
  };
  // One desktop notification per finished turn. The notifier itself is a no-op
  // on a terminal that cannot show it (notifications.ts decides), so the
  // extension is always registered and the gate never depends on ambient env.
  const notifyExtension: InlineExtension = { name: "qronos-notify", factory: createNotifyExtension()! };
  void notificationsEnabled;
  // Tier 2 item 6: lifecycle hooks. User-level hooks.json first, then project
  // hooks; both are merged so a project can add to (not silently replace) the
  // user's hooks. Parsed per runtime build so an edit takes effect on reload.
  const hooksExtension: InlineExtension = createHooksExtension({
    config: mergeHookConfigs(
      parseHookConfig(readHooksFile(getHooksPath())),
      parseHookConfig(readHooksFile(getProjectHooksPath(process.cwd()))),
    ),
    cwd: () => process.cwd(),
  });
  const toolAliasesExtension: InlineExtension = createToolAliasesExtension();
  const mcpExtension: InlineExtension = { name: "pi-mcp", factory: createMcpExtension() };
  const codemodeExtension: InlineExtension = { name: "pi-codemode", factory: createCodemodeExtension({ models: false }) };
  const toolSearchExtension: InlineExtension = { name: "pi-tool-search", factory: createToolSearchExtension() };

  // Closed, SEVENTEEN-item list — SB1's structural test fails if a future edit
  // adds or drops one. Settings deliberately omit pi packages (`packages: []`,
  // so no subagent extension or registry MCP adapter can be pulled in) and
  // pin `defaultTools` to the built-in tool set plus `todo`. The only MCP
  // servers that load are the ones the user put in mcp.json; the MCP
  // extension turns `codemode` on when one connects, and the model reaches
  // MCP tools through codemode scripts (every call still passes the guard).
  const extensionFactories = [
    providerExtension,
    createFusionExtension(models[0]!.id, resolveFusionIds(models.map((m) => m.id), opts.fusion)),
    // Before ads on purpose: pi stacks aboveEditor widgets in insertion order,
    // so registering this one first keeps the working line above the ad box.
    workingLineExtension,
    adsExtension,
    usageToolExtension,
    buyToolExtension,
    docsToolExtension,
    webToolsExtension,
    imageToolExtension,
    errorNoticeExtension,
    toolGuardExtension,
    commandsExtension,
    headerExtension,
    todoToolExtension,
    exitPlanToolExtension,
    agentToolExtension,
    agentHubExtension,
    fileCompletionExtension,
    hooksExtension,
    toolAliasesExtension,
    mcpExtension,
    codemodeExtension,
    toolSearchExtension,
    createClaudeToolRendererExtension(),
    createPromptHistoryExtension(),
    patchToolExtension,
    lspToolExtension,
    // Optional, appended only when configured; undefined entries are dropped.
    advisorExtension,
    streamRulesExtension,
    notifyExtension,
  ].filter((extension): extension is InlineExtension => extension !== undefined);

  const settingsManager = buildSettingsManager(opts, models, opts.projectTrusted === true);

  return {
    settingsManager,
    // The override form, not appendSystemPrompt: that one turns off pi's
    // discovery of the user's own APPEND_SYSTEM.md.
    resourceLoaderOptions: {
      extensionFactories,
      additionalSkillPaths: [SKILLS_DIR],
      appendSystemPromptOverride: (base) => {
        // Tier 2 item 5: layered memory (~/.qronos/QRONOS.md, then the project's
        // QRONOS.md). Resolved per runtime build so an edit is picked up on
        // reload, and empty when there is no memory file to avoid wasting
        // prompt tokens.
        const memory = loadMemoryPrompt(process.cwd(), getUserMemoryPath());
        return memory === "" ? [...base, AGENT_RULES] : [...base, AGENT_RULES, memory];
      },
    },
    extensionNames: extensionFactories.map((e) => (e as { name: string }).name),
    tools: SDK_TOOLS,
  };
}

/**
 * Launch the real pi TUI wired to the qronos provider. This is the seam
 * `run.ts` calls through `RunDeps.launchPi` so tests can stub it out — the
 * real pi SDK integration below is exercised only when the bin is actually
 * run, never in `bun test` (starting the real TUI needs a real terminal).
 */
function getSessionDir(cwd: string, agentDir: string): string {
  const resolvedCwd = resolve(cwd);
  const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
}

export interface SessionManagerApi {
  create: typeof SessionManager.create;
  open: typeof SessionManager.open;
  list: typeof SessionManager.list;
}

/** Resolves the requested logical session using one explicit session directory. */
export async function createSessionManager(
  cwd: string,
  sessionDir: string,
  sessionId: string | undefined,
  api: SessionManagerApi = SessionManager,
): Promise<SessionManager> {
  if (sessionId) {
    const infos = await api.list(cwd, sessionDir);
    if (sessionId === "latest") {
      if (infos.length > 0) {
        return api.open(infos[0]!.path, sessionDir);
      }
      return api.create(cwd, sessionDir);
    }
    const info = infos.find((session) => session.id === sessionId || session.id.startsWith(sessionId));
    if (!info) {
      throw new Error(`No session found matching '${sessionId}' in this directory`);
    }
    return api.open(info.path, sessionDir);
  }
  return api.create(cwd, sessionDir);
}

/**
 * qronos-cli users installed `qronos-cli` (via npx), never `pi` directly —
 * pi's own interactive mode otherwise shows a "New version available, run
 * `pi update`" banner (checkForNewPiVersion in the SDK, gated only by this
 * env var) that names a command our users don't have. qronos-cli already
 * has its own correctly-branded update check (update-check.ts / run.ts,
 * "run `npx qronos-cli@latest`"), so pi's own banner is pure noise here —
 * suppress it. Does not affect pi's separate model-catalog refresh (gated by
 * PI_OFFLINE instead), which stays on.
 */
process.env.PI_SKIP_VERSION_CHECK = "1";

// Pi reads PI_TELEMETRY ahead of the enableInstallTelemetry setting (core/telemetry.js).
process.env.PI_TELEMETRY = "0";

// Same brand-leak problem at the other end of the session: pi's exit path
// prints "To resume this session: pi --session <id>" straight to stdout and
// then exits the process. See resume-line.ts.
patchResumeLine(process.stdout);

/**
 * Patch UserMessageComponent to render user messages as a single, solid #3a3a3a box:
 * 1. Bounded to (width - 1) so padding never touches the exact right terminal boundary
 * and triggers terminal autowrap (which inserts a blank black line on narrow mobile screens).
 * 2. Does not emit OSC 133 command zone escapes that trigger VS Code Codespaces to draw
 * terminal command decoration rules through the message block.
 */
UserMessageComponent.prototype.render = function (width: number): string[] {
  const safeWidth = Math.max(1, width - 1);
  return Container.prototype.render.call(this, safeWidth);
};

/**
 * Patch InteractiveMode's built-in /logout handler so it clears Qronos AI credentials
 * (~/.qronos/agent/credentials.json) without registering a conflicting extension command.
 */
interface OAuthSelectorHost {
  showOAuthSelector?: (mode: string) => unknown;
  showStatus?: (message: string) => void;
  showError?: (message: string) => void;
}

const interactiveProto = InteractiveMode.prototype as unknown as OAuthSelectorHost;
const originalShowOAuthSelector = interactiveProto.showOAuthSelector;
interactiveProto.showOAuthSelector = async function (this: OAuthSelectorHost, mode: string) {
  if (mode === "logout") {
    try {
      const { clearJwt } = await import("./credentials");
      const { getCredentialsPath } = await import("./paths");
      await clearJwt(getCredentialsPath());
      if (typeof this.showStatus === "function") {
        this.showStatus("Logged out: credentials removed from ~/.qronos/agent/credentials.json. Run 'exit' or restart to sign in again.");
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (typeof this.showError === "function") {
        this.showError(`Failed to log out: ${message}`);
      }
    }
    return;
  }
  if (typeof originalShowOAuthSelector === "function") {
    return originalShowOAuthSelector.call(this, mode);
  }
  return undefined;
};

export async function launchPi(opts: LaunchOptions): Promise<string> {
  await ensureQronosTheme(opts.agentDir);
  // Ctrl+C must not wipe the prompt: pi reads keybindings.json when it builds
  // its keybinding manager, which happens inside the InteractiveMode below, so
  // the defaults have to be on disk before that.
  ensureKeybindingDefaults(opts.agentDir);
  // Smooth scrolling is ours to guarantee: the resolver is patched so "auto"
  // becomes one line per wheel notch, and the settings file records the same
  // values so the choice is discoverable.
  installSmoothScrolling();
  ensureUiDefaults(opts.agentDir);
  // QRONOS_FPS caps redraws for battery/SSH; no-op when unset.
  installFrameRateCap(process.env as Record<string, string | undefined>);
  const cwd = process.cwd();
  const sessionDir = getSessionDir(cwd, opts.agentDir);
  const sm = await createSessionManager(cwd, sessionDir, opts.session);

  // The pi logical session id is the lease key shared by the provider and ads.
  const sessionId = sm.getSessionId();
  const scopeIds = catalogModelsFor(opts).map((m) => m.id);
  const projectTrusted = await decideProjectTrustInteractive(cwd, opts.agentDir);
  const { resourceLoaderOptions, tools } = buildRuntimeOptions({ ...opts, projectTrusted }, sessionId);
  const launchTrust = { cwd, trusted: projectTrusted };

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd: rtCwd,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd: rtCwd,
      agentDir: opts.agentDir,
      // Trust is per folder: /resume may switch to a session from another one.
      settingsManager: settingsForRuntime(opts, rtCwd, launchTrust),
      resourceLoaderOptions,
    });
    // Lock the model picker to just the qronos catalog models — pi's own
    // model-scope, no env vars touched. See provider-lock.ts.
    const scopedModels = resolveQronosScope(services.modelRuntime, PROVIDER_NAME, scopeIds);
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        sessionStartEvent,
        tools: [...tools],
        scopedModels,
      })),
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd,
    agentDir: opts.agentDir,
    sessionManager: sm,
  });

  const mode = new InteractiveMode(runtime, {
    initialImages: [],
    initialMessages: [],
  });
  // 0.5.0: restore the execution mode chosen in a previous session so a user
  // who works in plan mode does not get silently dropped back into auto mode
  // every time they relaunch. An explicit --dangerously-skip-permissions flag
  // still wins (initExecutionMode handles that precedence).
  const savedConfig = readConfigObject(getConfigPath());
  const restoredMode = isExecutionMode(savedConfig?.executionMode) ? savedConfig.executionMode : undefined;
  initExecutionMode(opts.dangerouslySkipPermissions, restoredMode);
  setExecutionModePersistence((next) => {
    writeConfigPatch(getConfigPath(), { executionMode: next });
  });
  installBugHandler(mode, { baseUrl: opts.baseUrl, getToken: () => opts.jwt });
  installEffortHandler(mode);
  const statusLineCommand = readStatusLineCommand(getConfigPath());
  installFooterRightAlign(mode, { statusLineCommand });

  // Double-Esc recalls the last prompt. Wraps editor.onEscape rather than
  // registering Escape (which is pi's app.interrupt binding) so interrupt and
  // the tree/selector behaviour pi already provides keep working.
  // Escape stays purely "interrupt" / "cancel", exactly as in Claude Code and as
  // pi binds it (app.interrupt). Recall is NOT grafted onto Escape: doing so made
  // a second Esc ambiguous between "abort" and "restore", which is the behaviour
  // the user rejected. Prompt history is available on a dedicated key instead
  // (see the prompt-recall command), so the two gestures never collide.

  await mode.run();
  return sm.getSessionId();
}
