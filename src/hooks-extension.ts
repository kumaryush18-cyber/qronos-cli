// Wires the hooks from settings into pi's lifecycle events.
//
// PreToolUse is the important one: a blocking hook returns block:true from the
// tool_call handler, which is the same mechanism tool-guard uses, so hook and
// permission blocks compose instead of fighting.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { parseHookConfig, type HookConfig } from "./hooks";
import { runEventHooks, type HookRunnerDeps } from "./hooks-runner";

export interface CreateHooksOptions {
  /** Already-parsed config; the caller reads settings. */
  config: HookConfig;
  cwd: () => string;
  sessionId?: () => string | undefined;
  /** Injected in tests. */
  deps?: HookRunnerDeps;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
}

export const HOOKS_EXTENSION_NAME = "qronos-hooks";

export function createHooksExtension(opts: CreateHooksOptions): InlineExtension {
  return {
    name: HOOKS_EXTENSION_NAME,
    factory(pi: ExtensionAPI) {
      const config = opts.config;
      const has = (event: keyof HookConfig) => (config[event]?.length ?? 0) > 0;

      // Nothing configured: register no handlers at all, so a user with no
      // hooks pays nothing per tool call.
      if (Object.keys(config).length === 0) return;

      // Hook failures leave a persistent transcript line rather than a
      // transient toast: a warning the user can scroll back to is the whole
      // point of surfacing it. Falls back to notify when sendMessage is absent.
      const reportWarnings = (warnings: string[]) => {
        if (warnings.length === 0) return;
        const text = warnings.map((w) => `Hook warning: ${w}`).join("\n");
        opts.notify?.(text, "warning");
        try {
          pi.sendMessage({
            customType: "qronos-hook-warning",
            content: text,
            display: true,
          });
        } catch {
          // Older pi without sendMessage: the notify above is enough.
        }
      };

      const base = () => ({
        cwd: opts.cwd(),
        session_id: opts.sessionId?.(),
      });

      pi.on("tool_call", async (event, ctx) => {
        if (!has("PreToolUse")) return undefined;
        const { blocked, warnings } = await runEventHooks(
          config,
          "PreToolUse",
          {
            hook_event_name: "PreToolUse",
            ...base(),
            tool_name: event.toolName,
            tool_input: event.input,
          },
          opts.deps,
        );
        reportWarnings(warnings);
        if (blocked) {
          return { block: true, reason: `Blocked by PreToolUse hook (${blocked.command}): ${blocked.reason}` };
        }
        return undefined;
      });

      pi.on("tool_execution_end", async (event) => {
        if (!has("PostToolUse")) return;
        const { warnings } = await runEventHooks(
          config,
          "PostToolUse",
          {
            hook_event_name: "PostToolUse",
            ...base(),
            tool_name: event.toolName,
            tool_result: event.result,
            tool_error: event.isError,
          },
          opts.deps,
        );
        // PostToolUse cannot block: the tool already ran. Failures are warnings.
        reportWarnings(warnings);
      });

      pi.on("session_start", async (event, ctx) => {
        if (!has("SessionStart")) return;
        const { warnings } = await runEventHooks(
          config,
          "SessionStart",
          {
            hook_event_name: "SessionStart",
            cwd: ctx.cwd,
            session_id: opts.sessionId?.(),
            source: event.reason,
          },
          opts.deps,
        );
        for (const w of warnings) opts.notify?.(`Hook warning: ${w}`, "warning");
      });

      pi.on("turn_end", async () => {
        // "Stop" fires when the agent finishes a turn, matching Claude Code's
        // Stop hook. It cannot block by design; there is nothing to block.
        if (!has("Stop")) return;
        const { warnings } = await runEventHooks(
          config,
          "Stop",
          { hook_event_name: "Stop", ...base() },
          opts.deps,
        );
        reportWarnings(warnings);
      });

      pi.on("turn_start", async (event) => {
        // UserPromptSubmit fires per user turn; the prompt text is not exposed
        // on turn_start, so the payload carries the turn index only.
        if (!has("UserPromptSubmit")) return;
        const { warnings } = await runEventHooks(
          config,
          "UserPromptSubmit",
          { hook_event_name: "UserPromptSubmit", ...base(), source: String(event.turnIndex) },
          opts.deps,
        );
        reportWarnings(warnings);
      });
    },
  };
}

export { parseHookConfig };
