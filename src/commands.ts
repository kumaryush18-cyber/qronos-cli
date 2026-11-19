// 0.2.6: qronos's slash commands — /close-other-session (self-service lease
// reset), /whats-new (bundled changelog), /update (self-update trigger), and
// 0.2.12: /buy-credits (opens the buy page;. One inline extension
// (qronos-commands) registers all four. Grouped here rather than in
// usage-tool, which stays read-only.
import type { ExtensionAPI, ExtensionCommandContext, InlineExtension } from "@earendil-works/pi-coding-agent";
import { SessionResetResponseSchema } from "@qronos/shared";
import { registerBugAutocomplete } from "./bug-report";
import { CHANGELOG_HIGHLIGHTS } from "./changelog";
import { openBrowser } from "./browser";
import { BUY_NOT_AVAILABLE_TEXT, buyPageText, resolveBuyPage } from "./buy-tool";
import { detectReaBackends, summarizeReaBackends } from "./rea-backends";
import { fetchUsageText } from "./usage-tool";
import { runInit } from "./init-cmd";
import { runCost } from "./cost-cmd";
import { getExecutionMode, type ExecutionMode } from "./execution-modes";
import { HOOK_EVENTS, mergeHookConfigs, parseHookConfig } from "./hooks";
import { readHooksFile } from "./cli-config";
import { getHooksPath, getProjectHooksPath, getUserMemoryPath } from "./paths";
import { loadMemory, memoryPathsFor } from "./memory-io";
import { historySize, recallInto, type EditorLike } from "./interrupt-handler";
import { formatContextBreakdown, getLatestContextStats, updateContextStats } from "./context-view";
import { execSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { getConfigPath } from "./paths";
import { CLI_VERSION } from "./version";

export interface CreateCommandsOptions {
  baseUrl: string;
  /** Reads the current JWT from the cli's credential store. May be async. */
  getToken: () => string | Promise<string>;
  apiKey?: string;
  provider?: string;
  model?: string;
  fetchImpl?: typeof fetch;
  /** Injected in tests; defaults to browser.ts's opener. */
  openBrowserImpl?: typeof openBrowser;
 /**: reads the click URL of the banner ad currently shown, set by
   * pi-ads' onBannerAd callback. Undefined when no ad is shown. */
  getAdvertiserUrl?: () => string | undefined;
  /** Injected in tests: overrides the npx command /reverse-engineer-anything registers. */
  reaServer?: { command: string; args: string[] };
  /** Injected in tests; defaults to process.versions.node. */
  nodeVersion?: string;
  /** Injected in tests; defaults to process.platform. */
  platform?: NodeJS.Platform;
  /** Injected in tests: the backend readiness check used by /reverse-engineer-anything. */
  detectReaBackends?: typeof detectReaBackends;
}

/** Minimal shape of the command context we use — just the notify surface. */
export interface NotifyContext {
  ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
}

// ---- /close-other-session -------------------------------------------------

/**
 * Force-releases the caller's own stuck session lease via POST /session/reset.
 * Never throws — every failure resolves to a friendly notify line.
 */
export async function closeOtherSession(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    const token = await opts.getToken();
    const res = await fetchImpl(new URL("/session/reset", opts.baseUrl), {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      ctx.ui.notify("Couldn't reset your session (the server said no) — try again in a moment.", "error");
      return;
    }
    const parsed = SessionResetResponseSchema.safeParse(await res.json());
    const released = parsed.success ? parsed.data.released : false;
    ctx.ui.notify(
      released
        ? "Cleared your other session — you can start a new one now."
        : "No other session was running.",
      "info",
    );
  } catch {
    ctx.ui.notify("Couldn't reach qronos to reset your session — check your connection.", "error");
  }
}

// ---- /whats-new -----------------------------------------------------------

/** Shows the bundled changelog highlights for the most recent versions. */
export function showWhatsNew(ctx: NotifyContext): void {
  const lines = CHANGELOG_HIGHLIGHTS.slice(0, 3).flatMap((e) => [
    `qronos ${e.version}:`,
    ...e.highlights.map((h) => `  • ${h}`),
  ]);
  ctx.ui.notify(lines.join("\n"), "info");
}

// ---- /update --------------------------------------------------------------

export interface UpdateDeps {
  env?: Record<string, string | undefined>;
  /** Installs qronos-cli@latest globally; injected in tests. */
  installLatest?: () => Promise<{ ok: boolean }>;
}

function isEphemeralNpx(env: Record<string, string | undefined>): boolean {
  return env.npm_command === "exec" || env.npm_lifecycle_event === "npx";
}

async function defaultInstallLatest(): Promise<{ ok: boolean }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    // shell on win32: npm is `npm.cmd`, a batch file. Node refuses to spawn a
    // cmd without a shell (CVE-2024-27980 hardening), so this resolved
    // { ok: false } on every Windows /update. Same root cause as the
    // self-update spawn — the command is a fixed literal, no quoting surface.
    const child = spawn("npm", ["install", "-g", "qronos-cli@latest"], {
      stdio: "ignore",
      shell: process.platform === "win32",
    });
    child.on("error", () => resolve({ ok: false }));
    child.on("close", (code) => resolve({ ok: code === 0 }));
  });
}

/**
 * On-demand update. An npx run is always the latest by definition, so it's a
 * no-op there; a global install runs `npm install -g qronos-cli@latest`.
 * Never throws.
 */
export async function runUpdate(ctx: NotifyContext, deps: UpdateDeps = {}): Promise<void> {
  const env = deps.env ?? process.env;
  if (isEphemeralNpx(env)) {
    ctx.ui.notify("You're running via npx, which always fetches the latest — you're already up to date.", "info");
    return;
  }
  ctx.ui.notify("Updating qronos-cli… (npm install -g qronos-cli@latest)", "info");
  try {
    const { ok } = await (deps.installLatest ?? defaultInstallLatest)();
    ctx.ui.notify(
      ok
        ? "Updated — restart qronos-cli to use the new version."
        : "Update failed. Try manually: npm install -g qronos-cli@latest",
      ok ? "info" : "error",
    );
  } catch {
    ctx.ui.notify("Update failed. Try manually: npm install -g qronos-cli@latest", "error");
  }
}

// ---- /buy-credits ---------------------------------------------------------

/**
 * Deliberate, discoverable "I want to buy" path: same resolver as
 * the qronos_buy_credits tool, but a slash command needs no model turn — it
 * works even when the user is out of usage and every completion is a 429.
 * Never throws.
 */
export async function buyCredits(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  const page = await resolveBuyPage(opts);
  if (page.kind === "error") return ctx.ui.notify(page.text, "error");
  if (page.kind === "unavailable") return ctx.ui.notify(BUY_NOT_AVAILABLE_TEXT, "info");
  (opts.openBrowserImpl ?? openBrowser)(page.url);
  ctx.ui.notify(buyPageText(page.url), "info");
}

// ---- /support ---------------------------------------------------------------

/**
 * Opens today's advertiser (the click URL of the currently-shown banner ad)
 * in the browser.: no reward, no server call of its own — the only
 * server contact is the browser following the click redirect. Never throws.
 */
export async function openAdvertiser(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  const url = opts.getAdvertiserUrl?.();
  if (!url) {
    ctx.ui.notify("No advertiser loaded yet.", "info");
    return;
  }
  (opts.openBrowserImpl ?? openBrowser)(url);
  ctx.ui.notify("Opening today's advertiser in your browser. Thank you for supporting Qronos CLI.", "info");
}

// ---- /tos / /privacy-policy -------------------------------------------------

export const TERMS_URL = "https://qronos.me/terms";
export const PRIVACY_URL = "https://qronos.me/privacy";

/** Opens the Terms of Service in the browser. Never throws. */
export async function openTos(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  (opts.openBrowserImpl ?? openBrowser)(TERMS_URL);
  ctx.ui.notify(`Opening the Terms of Service in your browser: ${TERMS_URL}`, "info");
}

/** Opens the Privacy Policy in the browser. Never throws. */
export async function openPrivacyPolicy(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  (opts.openBrowserImpl ?? openBrowser)(PRIVACY_URL);
  ctx.ui.notify(`Opening the Privacy Policy in your browser: ${PRIVACY_URL}`, "info");
}

// ---- /usage ---------------------------------------------------------------

/** Same output as the qronos_usage tool, with no model turn — works at the wall. Never throws. */
export async function showUsage(opts: CreateCommandsOptions, ctx: NotifyContext): Promise<void> {
  const r = await fetchUsageText(opts);
  ctx.ui.notify(r.text, r.ok ? "info" : "error");
}

// ---- /reverse-engineer-anything ---------------------------------------------


const REA_ARGS = ["-y", "rea-agents@6.7.0", "mcp"];
const REA_DESCRIPTION =
  "Reverse-engineering tools (REA): native binaries, JS/Electron apps, APKs, .NET, websites. Use for lawful, authorized analysis only.";
const REA_NODE_RANGE = "^22.19.0, ^24.11.0, or >=26.0.0";

/** rea-agents' engines range: ^22.19.0 || ^24.11.0 || >=26.0.0 (no semver dependency for one range). */
function reaSupportsNode(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major >= 26 || (major === 24 && minor >= 11) || (major === 22 && minor >= 19);
}

/**
 * Registers the rea MCP server for this session only. Registering it at
 * startup would spawn it for every user and add a line to every system prompt,
 * so it happens only here. Never throws.
 */
export function loadRea(qronos: Pick<ExtensionAPI, "registerMcpServer" | "getMcpServers">, opts: CreateCommandsOptions, ctx: NotifyContext): void {
  const nodeVersion = opts.nodeVersion ?? process.versions.node;
  if (!reaSupportsNode(nodeVersion)) {
    ctx.ui.notify(`REA needs Node ${REA_NODE_RANGE}; you are on Node ${nodeVersion}. Update Node and restart qronos-cli.`, "error");
    return;
  }
  if (qronos.getMcpServers().some((s) => s.name === "rea")) {
    ctx.ui.notify("REA is already loaded in this session.", "info");
    return;
  }
  const win = (opts.platform ?? process.platform) === "win32";
  const server = opts.reaServer ?? (win ? { command: "cmd.exe", args: ["/d", "/c", "npx", ...REA_ARGS] } : { command: "npx", args: REA_ARGS });
  try {
    // 300 s per request: the first npx download and native decompiles can outlast pi's 60 s default.
    qronos.registerMcpServer("rea", { ...server, exposure: "codemode", description: REA_DESCRIPTION, timeout: 300 });
  } catch {
    ctx.ui.notify("Couldn't load REA in this session.", "error");
    return;
  }
  // Say what can really run here before the user asks for work: REA refuses
  // with "capability_unavailable" when its backend program is missing, which
  // reads like a broken install.
  const backends = (opts.detectReaBackends ?? detectReaBackends)({ env: process.env, platform: opts.platform ?? process.platform });
  ctx.ui.notify(
    "Loading REA (reverse-engineering tools) for this session. The first run downloads rea-agents, so it can take a minute. " +
      "Deep native analysis needs your own Hopper, Ghidra, or IDA install. " +
      summarizeReaBackends(backends),
    "info",
  );
}

// ---- extension ------------------------------------------------------------

/** Human summary of what each mode auto-approves, for /permissions. */
function describeMode(mode: ExecutionMode): string {
  switch (mode) {
    case "auto":
      return "Edits and reads run freely. bash commands pause only when they look destructive.";
    case "edit-automatically":
      return "File edits are applied without asking. Every bash command asks first.";
    case "plan":
      return "Read-only. Writes are refused and bash is limited to inspection commands (ls, cat, git diff...).";
    case "manual":
      return "Every file edit and every bash command asks for approval.";
    case "dangerously-skip-permissions":
      return "Nothing is checked. The agent can edit and run anything without asking.";
  }
}

/**
 * /recall: restore a previous prompt into the editor.
 *
 * Deliberately a command rather than a second Escape press: Escape is interrupt
 * ("Cancel or abort") in both pi and Claude Code, and overloading it made an
 * abort double-tap silently rewrite the input box.
 */
async function runRecall(
  args: string | undefined,
  ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } },
): Promise<void> {
  const raw = (args ?? "").trim();
  const index = raw === "" ? 0 : Number(raw);
  if (raw !== "" && (!Number.isInteger(index) || index < 0)) {
    ctx.ui.notify("Usage: /recall [n] — n counts back from the most recent prompt (default 0).", "warning");
    return;
  }

  const ui = ctx.ui as unknown as EditorLike | undefined;
  const result = recallInto(ui, index);

  switch (result.reason) {
    case "empty-history":
      ctx.ui.notify("No prompts yet in this session.", "info");
      return;
    case "out-of-range":
      ctx.ui.notify(`Only ${historySize()} prompt(s) in history.`, "info");
      return;
    case "no-editor":
      ctx.ui.notify("This session has no editor to restore into.", "warning");
      return;
    case "editor-busy":
      ctx.ui.notify("The editor already has text. Clear it first, then run /recall.", "warning");
      return;
    default:
      ctx.ui.notify(`Restored: ${(result.restored ?? "").slice(0, 60)}`, "info");
  }
}

/** /memory: show which memory layers resolved, and any broken @imports. */
async function showMemory(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): Promise<void> {
  const root = process.cwd();
  const memory = loadMemory(root, getUserMemoryPath());
  const checked = memoryPathsFor(root, getUserMemoryPath());

  const lines: string[] = [];
  if (memory.sources.length === 0) {
    lines.push("No memory loaded.", "", "Create one with /init (writes QRONOS.md here),");
    lines.push(`or add ${getUserMemoryPath()} to apply to every project.`);
  } else {
    lines.push("Loaded memory, lowest precedence first:");
    for (const s of memory.sources) lines.push(`  [${s.layer}] ${s.path} (${s.contents.length} chars)`);
    lines.push("", "Later entries override earlier ones.");
  }
  if (memory.missing.length > 0) {
    lines.push("", "Broken @imports:");
    for (const m of memory.missing) lines.push(`  ${m}`);
  }
  if (memory.cycles.length > 0) {
    lines.push("", "Cyclic @imports skipped:");
    for (const c of memory.cycles) lines.push(`  ${c}`);
  }
  lines.push("", "Checked:", ...checked.map((c) => `  ${c}`));

  ctx.ui.notify(lines.join("\n"), memory.missing.length > 0 ? "warning" : "info");
}

/** /hooks: list what is configured, from both hook sources. */
async function showHooks(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): Promise<void> {
  const user = parseHookConfig(readHooksFile(getHooksPath()));
  const project = parseHookConfig(readHooksFile(getProjectHooksPath(process.cwd())));
  const merged = mergeHookConfigs(user, project);

  const lines: string[] = [];
  for (const event of HOOK_EVENTS) {
    const matchers = merged[event];
    if (!matchers || matchers.length === 0) continue;
    lines.push(`${event}:`);
    for (const m of matchers) {
      const scope = m.matcher ? ` (matcher: ${m.matcher})` : "";
      for (const h of m.hooks) lines.push(`  $ ${h.command}${scope}`);
    }
  }

  if (lines.length === 0) {
    ctx.ui.notify(
      [
        "No hooks configured.",
        "",
        `Add them to ${getHooksPath()} (all projects) or .qronos/hooks.json (this project).`,
        "",
        "Example:",
        '{ "PreToolUse": [ { "matcher": "bash", "hooks": [ { "type": "command",',
        '    "command": "grep -q \"rm -rf\" && exit 2 || exit 0" } ] } ] }',
      ].join("\n"),
      "info",
    );
    return;
  }
  ctx.ui.notify(lines.join("\n"), "info");
}

async function showPermissions(ctx: { ui: { notify(message: string, type?: "info" | "warning" | "error"): void } }): Promise<void> {
  const mode = getExecutionMode();
  const lines = [
    `Execution mode: ${mode}`,
    "",
    describeMode(mode),
    "",
    "Press Shift+Tab in the prompt to cycle: auto -> accept edits -> plan -> manual.",
    "The mode is remembered between sessions in ~/.qronos/config.json.",
  ];
  ctx.ui.notify(lines.join("\n"), mode === "dangerously-skip-permissions" ? "warning" : "info");
}

async function showContext(ctx: ExtensionCommandContext, opts: CreateCommandsOptions): Promise<void> {
  const usage = ctx.getContextUsage();
  if (usage) {
    // ContextUsage carries only these three fields; the previous `any` read
    // input/output/cache numbers that never existed and showed zeros.
    updateContextStats({
      usedTokens: usage.tokens ?? 0,
      contextWindow: usage.contextWindow,
    });
  }
  const text = formatContextBreakdown(getLatestContextStats(), opts.model);
  ctx.ui.notify(text, "info");
}

async function showStatus(ctx: ExtensionCommandContext, opts: CreateCommandsOptions): Promise<void> {
  const mode = getExecutionMode();
  const memory = loadMemory(process.cwd(), getUserMemoryPath());
  // `getActiveTools` is not part of the public context type; read it
  // structurally and fall back to a word instead of a fake number.
  const activeTools = (ctx as unknown as { getActiveTools?: () => unknown[] }).getActiveTools?.();
  const activeToolsCount = activeTools?.length ?? "standard";
  const stats = getLatestContextStats();

  const lines = [
    `◈ Qronos CLI v${CLI_VERSION} Status`,
    "",
    `  • Execution Mode:    ${mode}`,
    `  • Active Model:      ${opts.model || "Default Model"}`,
    `  • Provider:          ${opts.provider || "qronos"}`,
    `  • Base URL:          ${opts.baseUrl}`,
    `  • Memory Sources:    ${memory.sources.length} active layer(s)`,
    `  • Active Tools:      ${activeToolsCount}`,
    `  • Context Window:    ${stats ? `${stats.usedTokens} / ${stats.contextWindow} tokens` : "no active tokens"}`,
    `  • Working Directory: ${process.cwd()}`,
  ];
  ctx.ui.notify(lines.join("\n"), "info");
}

async function showDoctor(ctx: NotifyContext, opts: CreateCommandsOptions): Promise<void> {
  const checks: string[] = [`◈ Qronos CLI v${CLI_VERSION} Diagnostics`, ""];

  // 1. Runtime environment
  const nodeVer = process.version;
  checks.push(`[✓] Runtime: Node ${nodeVer} on ${process.platform} (${process.arch})`);

  // 2. Git status
  try {
    const branch = execSync("git rev-parse --abbrev-ref HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    const status = execSync("git status --porcelain", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }).trim();
    const dirty = status.length > 0 ? "dirty working tree" : "clean";
    checks.push(`[✓] Git Repository: branch '${branch}' (${dirty})`);
  } catch {
    checks.push(`[-] Git Repository: not a git directory or git not available`);
  }

  // 3. Config file
  const configPath = getConfigPath();
  checks.push(existsSync(configPath) ? `[✓] Config File: ${configPath}` : `[i] Config File: none (using defaults)`);

  // 4. Memory files
  const memory = loadMemory(process.cwd(), getUserMemoryPath());
  if (memory.sources.length > 0) {
    checks.push(`[✓] Memory: ${memory.sources.length} QRONOS.md layers loaded`);
  } else {
    checks.push(`[i] Memory: No QRONOS.md found (run /init to create project instructions)`);
  }

  // 5. Hooks
  const userHooks = parseHookConfig(readHooksFile(getHooksPath()));
  const projHooks = parseHookConfig(readHooksFile(getProjectHooksPath(process.cwd())));
  const merged = mergeHookConfigs(userHooks, projHooks);
  const hookCount = Object.values(merged).reduce((acc, matchers) => acc + (matchers?.length || 0), 0);
  checks.push(hookCount > 0 ? `[✓] Lifecycle Hooks: ${hookCount} hook matcher(s) active` : `[i] Lifecycle Hooks: 0 configured`);

  // 6. Provider connection
  checks.push(`[✓] Provider: ${opts.provider || "qronos"} (${opts.baseUrl})`);

  ctx.ui.notify(checks.join("\n"), "info");
}

async function runReview(ctx: NotifyContext, qronos: ExtensionAPI): Promise<void> {
  let diff = "";
  try {
    diff = execSync("git diff HEAD", { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000 }).trim();
    if (!diff) {
      diff = execSync("git diff --staged", { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 5000 }).trim();
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.ui.notify(`Could not read git diff: ${message}`, "error");
    return;
  }

  if (!diff) {
    ctx.ui.notify("Working tree is clean — no git changes to review.", "info");
    return;
  }

  const prompt = [
    "Please perform a thorough code review of the following git diff.",
    "Review for correctness bugs, edge cases, performance issues, and adherence to project patterns.",
    "",
    "```diff",
    diff.slice(0, 40_000), // cap to prevent overwhelming
    "```",
  ].join("\n");

  qronos.sendUserMessage(prompt);
}

export async function runCompact(args: string, ctx: NotifyContext, qronos: ExtensionAPI): Promise<void> {
  const hint = args.trim();
  const prompt = [
    "Please compact our conversation context.",
    hint ? `Focus of compaction: ${hint}` : "Summarize all previous work, key technical decisions, current file changes, and remaining tasks.",
    "Preserve any active todos and plans. Be concise so that maximum context headroom is freed.",
  ].join("\n");
  ctx.ui.notify("Compacting conversation history...", "info");
  qronos.sendUserMessage(prompt);
}

/** Clipboard screenshots land here, relative to the folder qronos was started in. */
export const SCREENSHOTS_DIR = "screenshots";

/** Where a clipboard screenshot goes, absolute + relative, for a given clock. */
export function screenshotPaths(cwd: string, now: number = Date.now()): { targetPath: string; relPath: string } {
  const filename = `screenshot_${now}.png`;
  return {
    targetPath: join(cwd, SCREENSHOTS_DIR, filename),
    relPath: `${SCREENSHOTS_DIR}/${filename}`,
  };
}

export function saveClipboardImage(cwd: string): { ok: true; path: string } | { ok: false; error: string } {
  const screenshotsDir = join(cwd, SCREENSHOTS_DIR);
  if (!existsSync(screenshotsDir)) {
    try {
      mkdirSync(screenshotsDir, { recursive: true });
    } catch {}
  }
  const { targetPath, relPath } = screenshotPaths(cwd);

  // No shell here on purpose: the folder path comes from the user's working
  // directory, so a name containing a quote or `$(...)` must never be parsed
  // as shell code. Every command below is spawned with an argument array, and
  // the Linux writers get the output file as a file descriptor, not a `>`.
  try {
    if (process.platform === "win32") {
      // Single-quoted PowerShell string: literal, only a quote needs doubling.
      const psPath = targetPath.replace(/'/g, "''");
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; $c = [System.Windows.Forms.Clipboard]::GetImage(); if ($c) { $c.Save('${psPath}', [System.Drawing.Imaging.ImageFormat]::Png); exit 0 } else { exit 1 }`;
      spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", psScript], { timeout: 4000, stdio: "ignore" });
    } else if (process.platform === "darwin") {
      const asPath = targetPath.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
      const osa = `set png_data to the clipboard as «class PNGf»\nset fp to open for access POSIX file "${asPath}" with write permission\nwrite png_data to fp\nclose access fp`;
      spawnSync("osascript", ["-e", osa], { timeout: 4000, stdio: "ignore" });
    } else {
      const capture = (cmd: string, args: string[]): boolean => {
        const fd = openSync(targetPath, "w");
        try {
          return spawnSync(cmd, args, { timeout: 4000, stdio: ["ignore", fd, "ignore"] }).status === 0;
        } finally {
          closeSync(fd);
        }
      };
      const ok = capture("wl-paste", ["--type", "image/png"]);
      if (!ok) capture("xclip", ["-selection", "clipboard", "-t", "image/png", "-o"]);
    }

    if (existsSync(targetPath) && statSync(targetPath).size > 100) {
      return { ok: true, path: relPath };
    }
    return { ok: false, error: "No image found in clipboard. Take a screenshot (Win+Shift+S or Cmd+Shift+4) and retry." };
  } catch {
    return { ok: false, error: "No image found on clipboard or clipboard capture unavailable." };
  }
}

export function createCommandsExtension(opts: CreateCommandsOptions): InlineExtension {
  return {
    name: "qronos-commands",
    factory(qronos: ExtensionAPI) {
      // 0.3.0: keep /bug listed with a qronos description (the handler itself is installed in pi-launch.ts).
      registerBugAutocomplete(qronos);
      qronos.registerCommand("init", {
        description: "Initialize project instructions for Qronos AI (creates QRONOS.md).",
        handler: async (_args, ctx) => runInit(ctx),
      });
      qronos.registerCommand("cost", {
        description: "Show detailed session token usage and PAYG / Token Plan billing status.",
        handler: async (_args, ctx) => runCost(ctx, opts),
      });
      qronos.registerCommand("close-other-session", {
        description: "Clear your other running Qronos session (use if a previous one is stuck).",
        handler: (_args, ctx) => closeOtherSession(opts, ctx),
      });
      qronos.registerCommand("whats-new", {
        description: "Show what's new in recent Qronos CLI releases.",
        handler: async (_args, ctx) => showWhatsNew(ctx),
      });
      qronos.registerCommand("update", {
        description: "Update qronos-cli to the latest version.",
        handler: (_args, ctx) => runUpdate(ctx),
      });
      qronos.registerCommand("usage", {
        description: "Show credits left today, refill time, and purchased credit.",
        handler: (_args, ctx) => showUsage(opts, ctx),
      });
      qronos.registerCommand("buy-credits", {
        description: "Buy more usage packs or top up balance on qronos.me.",
        handler: (_args, ctx) => buyCredits(opts, ctx),
      });
      qronos.registerCommand("support", {
        description: "Open today's advertiser in your browser to support Qronos CLI.",
        handler: (_args, ctx) => openAdvertiser(opts, ctx),
      });
      qronos.registerCommand("tos", {
        description: "Open the Qronos Terms of Service in your browser.",
        handler: (_args, ctx) => openTos(opts, ctx),
      });
      qronos.registerCommand("privacy-policy", {
        description: "Open the Qronos Privacy Policy in your browser.",
        handler: (_args, ctx) => openPrivacyPolicy(opts, ctx),
      });
      qronos.registerCommand("reverse-engineer-anything", {
        description: "Load reverse-engineering tools (REA: binaries, apps, APKs, websites) for this session.",
        handler: async (_args, ctx) => loadRea(qronos, opts, ctx),
      });
      qronos.registerCommand("permissions", {
        description: "Show the active execution mode and what it will ask you to approve.",
        handler: (_args, ctx) => showPermissions(ctx),
      });
      qronos.registerCommand("recall", {
        description: "Put a previous prompt back in the editor (/recall, /recall 2 for older).",
        handler: (args, ctx) => runRecall(args, ctx),
      });
      qronos.registerCommand("memory", {
        description: "Show which QRONOS.md memory files are loaded for this project.",
        handler: (_args, ctx) => showMemory(ctx),
      });
      qronos.registerCommand("hooks", {
        description: "Show the lifecycle hooks configured for this session.",
        handler: (_args, ctx) => showHooks(ctx),
      });
      qronos.registerCommand("context", {
        description: "Show current context window token usage, remaining headroom, and auto-compact limit.",
        handler: (_args, ctx) => showContext(ctx, opts),
      });
      qronos.registerCommand("status", {
        description: "Show current session info, active model, execution mode, and working directory.",
        handler: (_args, ctx) => showStatus(ctx, opts),
      });
      qronos.registerCommand("doctor", {
        description: "Run diagnostics on your environment, API provider, git repo, memory, and hooks.",
        handler: (_args, ctx) => showDoctor(ctx, opts),
      });
      qronos.registerCommand("review", {
        description: "Review current git diff changes for correctness, bugs, and code quality.",
        handler: (_args, ctx) => runReview(ctx, qronos),
      });
      qronos.registerCommand("paste-image", {
        description: `Save a screenshot from your system clipboard to ${SCREENSHOTS_DIR}/ and inspect it with AI vision.`,
        handler: async (_args, ctx) => {
          const res = saveClipboardImage(ctx.cwd || process.cwd());
          if (res.ok) {
            ctx.ui.notify(
              `📸 Saved screenshot to: ${res.path}\nPrompt the model: "Inspect ${res.path} and analyze the layout"`,
              "info",
            );
          } else {
            ctx.ui.notify(`⚠️ ${res.error}`, "warning");
          }
        },
      });
    },
  };
}
