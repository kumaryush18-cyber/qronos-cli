// Stream rules extension: reads rule files, watches the streaming reply, and
// stops a turn the moment a banned pattern appears.
//
// Three hooks only:
//   turn_start        -> re-arm the watcher (rules fire once per turn)
//   message_update    -> scan the partial assistant text, abort on a match
//   before_agent_start-> attach the reminder to the next request as a system
//                        section, then drop it (it must not cost tokens forever)
//
// Everything that can be tested lives in stream-rules.ts; this file is the thin
// glue to pi's event surface.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  formatRuleReminder,
  parseStreamRules,
  ruleNotice,
  STREAM_RULES_SECTION,
  StreamRuleWatcher,
  type ParsedStreamRules,
  type StreamRule,
} from "./stream-rules";

export const RULES_FILE = "stream-rules.json";

export interface StreamRulesSources {
  /** Project rules, normally `<cwd>/.qronos/stream-rules.json`. */
  projectPath?: string;
  /** User rules, normally `~/.qronos/stream-rules.json`. */
  userPath?: string;
}

export interface StreamRulesOptions extends StreamRulesSources {
  /** Disabled rule names (from settings or env). */
  disabled?: readonly string[];
  /** Called when a rule fires, for the transcript line. */
  onFire?: (rule: StreamRule) => void;
  /** Lets tests skip disk access. */
  readFile?: (path: string) => string | undefined;
}

function readJson(path: string | undefined, readFile: (p: string) => string | undefined): unknown {
  if (!path) return undefined;
  const text = readFile(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return { __invalid: true };
  }
}

/**
 * Load and merge rules. Project rules come first so a project can override or
 * shadow a user rule with the same name (first definition wins).
 */
export function loadStreamRules(options: StreamRulesOptions = {}): ParsedStreamRules & { invalidFiles: string[] } {
  const readFile =
    options.readFile ??
    ((path: string) => {
      try {
        if (!existsSync(path)) return undefined;
        return readFileSync(path, "utf8");
      } catch {
        return undefined;
      }
    });

  const invalidFiles: string[] = [];
  const merged: StreamRule[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const path of [options.projectPath, options.userPath]) {
    if (!path) continue;
    const raw = readJson(path, readFile);
    if (raw === undefined) continue;
    if (raw && typeof raw === "object" && "__invalid" in (raw as object)) {
      invalidFiles.push(path);
      warnings.push(`stream rules: ${path} is not valid JSON, ignored`);
      continue;
    }
    const parsed = parseStreamRules(raw, options.disabled);
    warnings.push(...parsed.warnings.map((w) => `${w} (${path})`));
    for (const rule of parsed.rules) {
      if (seen.has(rule.name)) {
        warnings.push(`stream rules: "${rule.name}" already defined earlier, ignored in ${path}`);
        continue;
      }
      seen.add(rule.name);
      merged.push(rule);
    }
  }

  return { rules: merged, warnings, invalidFiles };
}

/** Default locations, resolved from the working directory and agent dir. */
export function defaultRulePaths(cwd: string, agentHome: string): StreamRulesSources {
  return {
    projectPath: join(cwd, ".qronos", RULES_FILE),
    userPath: join(agentHome, RULES_FILE),
  };
}

export interface StreamRulesRuntime {
  extension: ExtensionFactory;
  /** True when at least one rule loaded. */
  active: boolean;
  warnings: string[];
}

export function createStreamRulesExtension(options: StreamRulesOptions = {}): StreamRulesRuntime {
  const loaded = loadStreamRules(options);
  const watcher = new StreamRuleWatcher(loaded.rules);
  let pendingReminder: string | undefined;

  const extension: ExtensionFactory = (qronos: ExtensionAPI) => {
    if (loaded.rules.length === 0) return;

    qronos.on("turn_start", async () => {
      watcher.reset();
      // A reminder only survives until it has been delivered once.
      pendingReminder = undefined;
    });

    qronos.on("message_update", async (event, ctx: ExtensionContext) => {
      const message = event.message as { role?: string; content?: unknown } | undefined;
      if (!message || message.role !== "assistant") return;
      const text = assistantText(message.content);
      if (!text) return;

      const rule = watcher.push(text);
      if (!rule) return;

      pendingReminder = formatRuleReminder(rule);
      options.onFire?.(rule);
      try {
        ctx.ui.setStatus("qronos-stream-rule", ruleNotice(rule));
      } catch {
        // A status line is cosmetic; never let it break an abort.
      }
      // Stop the turn now: everything after this point would repeat the pattern.
      ctx.abort();
    });

    qronos.on("before_agent_start", async (event) => {
      if (!pendingReminder) return;
      const optionsWithSections = event.systemPromptOptions as { sections?: Record<string, string> };
      optionsWithSections.sections = { ...(optionsWithSections.sections ?? {}) };
      optionsWithSections.sections[STREAM_RULES_SECTION] = pendingReminder;
      pendingReminder = undefined;
    });
  };

  return { extension, active: loaded.rules.length > 0, warnings: loaded.warnings };
}

/** Flatten pi's assistant content blocks into plain text. */
export function assistantText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
      continue;
    }
    if (!block || typeof block !== "object") continue;
    const typed = block as { type?: string; text?: unknown; thinking?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    else if (typed.type === "thinking" && typeof typed.thinking === "string") parts.push(typed.thinking);
  }
  return parts.join("");
}
