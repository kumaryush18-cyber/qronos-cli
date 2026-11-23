// Models sometimes call bash with `cmd` or read with `file`/`file_path`, which
// pi rejects as a validation error and costs a wasted turn. Re-register those
// two built-ins (same definitions, same names) with a prepareArguments that
// renames the alias when the real key is missing. Nothing else changes.
//
// cwd: the built-in tools run in `ctx.cwd || cwd` (pi bash.js:174, read.js:73),
// so the session's cwd wins; the process cwd is only pi's own fallback.
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createBashToolDefinition,
  createPowerShellToolDefinition,
  createReadToolDefinition,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { toolDescriptionsEnabled } from "./env";

/**
 * The model-facing description of the optional step name.
 *
 * The wording follows Claude Code's own Bash schema on purpose: it names the
 * active voice, gives a length, and shows four worked examples. A bare
 * "describe the command" gets answered with the command again.
 */
export const STEP_PARAM_DESCRIPTION =
  "Clear, concise sentence in the active voice saying what this command does, 5-10 words. " +
  'Examples: "List files in current directory", "Show working tree status", ' +
  '"Install package dependencies", "Find and delete all .tmp files recursively". ' +
  'Never write "complex" or "risk"; describe the action itself.';

/** The guideline bullet that keeps the field filled in on every call. */
export const STEP_GUIDELINE =
  "Every bash and powershell call includes `description`: one short active-voice sentence about what the command does.";

/**
 * The parameter schema for a shell tool.
 *
 * With `withStep` false this is exactly pi's own schema (command + timeout),
 * so turning the feature off removes the field the model is asked to fill in.
 */
export function shellParameters(withStep: boolean) {
  const command = Type.String({ description: "Shell command to execute" });
  const timeout = Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }));
  if (!withStep) return Type.Object({ command, timeout });
  return Type.Object({
    command,
    description: Type.Optional(Type.String({ description: STEP_PARAM_DESCRIPTION })),
    timeout,
  });
}

/** Add the step guideline without dropping the tool's own guidelines. */
export function withStepGuideline(guidelines: readonly string[] | undefined, withStep: boolean): string[] {
  const base = [...(guidelines ?? [])];
  return withStep ? [...base, STEP_GUIDELINE] : base;
}

/** Rename the first present alias to `key`, only when `key` is absent. */
export function aliasArgs(input: unknown, key: string, aliases: string[]): unknown {
  if (!input || typeof input !== "object" || key in input) return input;
  const args = input as Record<string, unknown>;
  const alias = aliases.find((a) => a in args);
  if (!alias) return input;
  const { [alias]: value, ...rest } = args;
  return { ...rest, [key]: value };
}

/**
 * pi normalizes shellPath with normalizePath/normalizeWindowsShellPath
 * (pi-coding-agent dist/utils/paths.js, via SettingsManager.getShellPath).
 * They are not exported, so this repeats the behavior pi applies to shellPath:
 * Git Bash/MSYS/Cygwin/WSL drive paths on win32, ~ and ~/ (~\ on win32),
 * and file:// URLs. Pinned to pi 1.2.0.
 */
export function normalizeShellPath(
  input: string,
  platform: string = process.platform,
  home: string = homedir(),
): string {
  let p = input;
  if (platform === "win32" && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\")) {
    const m = p.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
    if (m) p = `${m[1]!.toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`;
  }
  if (p === "~") return home;
  if (p.startsWith("~/") || (platform === "win32" && p.startsWith("~\\"))) return join(home, p.slice(2));
  if (/^file:\/\//.test(p)) return fileURLToPath(p);
  return p;
}

export function createToolAliasesExtension(): InlineExtension {
  return {
    name: "qronos-tool-aliases",
    factory: (qronos: ExtensionAPI) => {
      const cwd = process.cwd();
      const bash = createBashToolDefinition(cwd);
      const read = createReadToolDefinition(cwd);
      const withStep = toolDescriptionsEnabled();

      // PowerShell only exists on a platform where pi registered it. Probing
      // getAllTools keeps us from adding a Windows-only tool on Linux, where
      // the model would then be offered a shell the machine cannot run.
      const hasPowerShell = (() => {
        try {
          return qronos.getAllTools().some((tool) => tool.name === "powershell");
        } catch {
          return false;
        }
      })();
      // pi builds its own bash/read from session settings (agent-session.js
      // _buildRuntime). Settings are not readable while a factory loads
      // (getSettings throws until the runner binds it), so build the real tool
      // inside execute, from the settings at that moment.
      qronos.registerTool({
        ...bash,
        // One optional field more than pi's schema. `execute` below is still
        // pi's own bash, so the description is carried for the display and
        // ignored by the runner.
        parameters: shellParameters(withStep) as never,
        promptGuidelines: withStepGuideline(bash.promptGuidelines, withStep),
        prepareArguments: (a) => aliasArgs(bash.prepareArguments ? bash.prepareArguments(a) : a, "command", ["cmd"]) as never,
        execute: (...args) => {
          const s = qronos.getSettings();
          const shellPath = s.shellPath ? normalizeShellPath(s.shellPath) : s.shellPath;
          return createBashToolDefinition(cwd, { commandPrefix: s.shellCommandPrefix, shellPath }).execute(...args);
        },
      });

      if (hasPowerShell) {
        const pwsh = createPowerShellToolDefinition(cwd);
        qronos.registerTool({
          ...pwsh,
          parameters: shellParameters(withStep) as never,
          promptGuidelines: withStepGuideline(pwsh.promptGuidelines, withStep),
          prepareArguments: (a) => aliasArgs(pwsh.prepareArguments ? pwsh.prepareArguments(a) : a, "command", ["cmd"]) as never,
          execute: (...args) => createPowerShellToolDefinition(cwd).execute(...args),
        });
      }
      qronos.registerTool({
        ...read,
        prepareArguments: (a) =>
          aliasArgs(read.prepareArguments ? read.prepareArguments(a) : a, "path", ["file", "file_path"]) as never,
        execute: (...args) =>
          createReadToolDefinition(cwd, { autoResizeImages: qronos.getSettings().images?.autoResize ?? true }).execute(...args),
      });
    },
  };
}
