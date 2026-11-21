// Memory, wired into pi.
//
// What a user gets, with no setup:
//   - every finished turn is journaled (locally, redacted, capped);
//   - at session start the project's memory is injected as hints;
//   - the `learn` tool lets the agent save a lesson immediately;
//   - `/memory` shows what is known, runs a sync, or clears it;
//   - a background sync folds old turns into the document when enough of them
//     have piled up (one model call, capped, never blocking the first prompt).
//
// Failure policy: memory is decoration around the chat. Every handler is
// wrapped so a broken file, a read-only home directory or a model error can
// never fail a turn, and never blocks the first prompt (the auto sync runs
// 2.5 s after session start, unref'd, and swallows its own errors).
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { getQronosAgentDir } from "./paths";
import { assistantText } from "./stream-rules-extension";
import { memoryConfigFromEnv, type MemoryConfig } from "./memory-config";
import { toolFileArgs } from "./tool-args";

export { toolFileArgs };
import { consolidate, shouldSync, type ExtractionModel } from "./memory-consolidate";
import { buildJournalEntry } from "./memory-journal";
import { MEMORY_SECTION, approxTokens, buildMemoryBlock, memoryStatusLabel } from "./memory-inject";
import { docItemCount, parseDoc, renderDoc, type MemoryDoc } from "./memory-doc";
import { addLesson, forgetLesson, parseLessons, renderLessons, type Lesson } from "./memory-lessons";
import { findRepoRoot, memoryFiles, type MemoryPaths } from "./memory-paths";
import {
  acquireLock,
  appendJournal,
  readJournal,
  readState,
  readText,
  releaseLock,
  rewriteJournal,
  writeAtomic,
  writeState,
} from "./memory-store";

export const MEMORY_STATUS_KEY = "qronos-memory";
export const MEMORY_TOOL_NAME = "learn";
/** Delay before the background sync, so the first prompt is never delayed. */
export const AUTO_SYNC_DELAY_MS = 2500;

export interface MemoryExtensionOptions {
  config?: MemoryConfig;
  /** Defaults to the Qronos agent dir; a test passes a temp dir. */
  agentDir?: string;
  /** Injected in tests to avoid a real model call. */
  extract?: ExtractionModel;
  now?: () => number;
  /** Injected in tests. */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
}

interface LiveMemory {
  paths: MemoryPaths;
  cwd: string;
  root: string;
  projectName: string;
  doc: MemoryDoc;
  lessons: Lesson[];
}

function loadLive(paths: MemoryPaths, cwd: string, root: string): LiveMemory {
  const doc = parseDoc(readText(paths.doc));
  const lessons = parseLessons(readText(paths.lessons));
  return { paths, cwd, root, projectName: root.split(/[/\\]/).filter(Boolean).pop() ?? "project", doc, lessons };
}

/** File paths worth remembering from one tool call's arguments. */
/** Resolve the model used for extraction: explicit setting, else the session model. */
function resolveMemoryModel(ctx: ExtensionContext, config: MemoryConfig): unknown {
  const sessionModel = (ctx as { model?: { provider?: string; id?: string } }).model;
  const registry = (ctx as unknown as {
    modelRegistry?: {
      find(provider: string, id: string): unknown;
      getModelsOfType(type: string): ReadonlyArray<{ id?: string }>;
    };
  }).modelRegistry;
  const wanted = config.model?.toLowerCase();
  if (!wanted || !registry) return sessionModel;
  if (sessionModel?.provider) {
    const inProvider = registry.find(sessionModel.provider, config.model!);
    if (inProvider) return inProvider;
  }
  return (
    registry.getModelsOfType("chat").find((model) => model.id?.toLowerCase() === wanted) ?? sessionModel
  );
}

/** Real extraction call, using the same compat surface as the advisor. */
function realExtraction(ctx: ExtensionContext, config: MemoryConfig): ExtractionModel {
  return async (systemPrompt, userPrompt) => {
    const model = resolveMemoryModel(ctx, config) as Parameters<typeof completeSimple>[0] | undefined;
    if (!model) throw new Error("no model available for memory extraction");
    const registry = (ctx as unknown as {
      modelRegistry?: {
        getApiKeyAndHeaders(model: unknown): Promise<{ apiKey?: string; headers?: Record<string, string> }>;
      };
    }).modelRegistry;
    const auth = registry ? await registry.getApiKeyAndHeaders(model) : {};
    const response = (await completeSimple(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: userPrompt }] }],
      },
      { apiKey: auth.apiKey, headers: auth.headers },
    )) as { content?: unknown };
    const content = response.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content
      .filter(
        (block): block is { type: string; text: string } =>
          !!block && typeof block === "object" && (block as { type?: string }).type === "text",
      )
      .map((block) => block.text)
      .join("\n");
  };
}

/**
 * Build the extension. Always returns an extension (registered even when the
 * feature is off, so the extension list stays stable), which does nothing when
 * `config.enabled` is false.
 */
export function createMemoryExtension(options: MemoryExtensionOptions = {}): InlineExtension {
  const config = options.config ?? memoryConfigFromEnv();
  const agentDir = options.agentDir ?? getQronosAgentDir();
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms) as { unref?: () => void });

  let live: LiveMemory | undefined;
  let pendingPrompt = "";
  let turnTools: string[] = [];
  let turnFiles: string[] = [];
  let syncing = false;

  const ensureLive = (cwd: string): LiveMemory => {
    if (live && live.cwd === cwd) return live;
    const root = findRepoRoot(cwd);
    live = loadLive(memoryFiles(agentDir, cwd, root), cwd, root);
    return live;
  };

  const refresh = (cwd: string): LiveMemory => {
    const root = findRepoRoot(cwd);
    live = loadLive(memoryFiles(agentDir, cwd, root), cwd, root);
    return live;
  };

  const extractFor = (ctx: ExtensionContext): ExtractionModel => options.extract ?? realExtraction(ctx, config);

  const runSync = async (ctx: ExtensionContext, manual: boolean): Promise<string> => {
    if (syncing) return "A memory sync is already running.";
    syncing = true;
    try {
      const current = refresh(ctx.cwd);
      const before = docItemCount(current.doc);
      const result = await consolidate({
        paths: current.paths,
        extract: extractFor(ctx),
        projectName: current.projectName,
        now,
      });
      const after = refresh(ctx.cwd);
      updateStatus(ctx, after);
      const added = docItemCount(after.doc) - before;
      switch (result.status) {
        case "synced":
          return `Memory updated: ${added > 0 ? `+${added}` : "no"} new item${added === 1 ? "" : "s"}, ${after.doc.sections.decisions.length + after.doc.sections.constraints.length + after.doc.sections.workflows.length + after.doc.sections.failures.length + after.doc.sections.preferences.length} known. Read from ${result.consumed} turn${result.consumed === 1 ? "" : "s"}.`;
        case "nothing-new":
          return "Nothing new to learn yet: no turns have piled up since the last sync.";
        case "busy":
          return "Another sync is running.";
        case "model-failed":
          return `Memory sync skipped (model error): ${result.reason ?? "unknown"}. Existing memory was kept.`;
        case "bad-answer":
          return `Memory sync skipped (the model's answer was unusable): ${result.reason ?? "unknown"}. Existing memory was kept.`;
        case "write-failed":
          return "Memory sync could not write to the agent directory. Existing memory was kept.";
        default:
          return manual ? "Memory sync finished." : "";
      }
    } catch (error) {
      return `Memory sync failed: ${error instanceof Error ? error.message : String(error)}. Existing memory was kept.`;
    } finally {
      syncing = false;
    }
  };

  const updateStatus = (ctx: ExtensionContext, current: LiveMemory): void => {
    if (!config.statusLine) return;
    const label = memoryStatusLabel(current.doc, current.lessons);
    try {
      ctx.ui.setStatus(MEMORY_STATUS_KEY, label === "" ? undefined : label);
    } catch {
      // A status line is cosmetic.
    }
  };

  const extension: ExtensionFactory = (qronos: ExtensionAPI) => {
    qronos.on("session_start", async (_event, ctx) => {
      if (!config.enabled) return;
      try {
        const current = ensureLive(ctx.cwd);
        updateStatus(ctx, current);
        if (!config.auto) return;
        // Never before the first prompt: a background timer that the event loop
        // does not wait for, so startup stays instant even on a slow disk.
        setTimer(() => {
          void (async () => {
            try {
              const state = readState(current.paths);
              const journal = readJournal(current.paths);
              if (!shouldSync(state, journal, { minTurns: config.minTurns, minIntervalMs: config.minIntervalMs, now: now() })) return;
              await runSync(ctx, false);
            } catch {
              // Background work never surfaces an error to the user.
            }
          })();
        }, AUTO_SYNC_DELAY_MS).unref?.();
      } catch {
        // No memory is a valid state.
      }
    });

    qronos.on("before_agent_start", async (event, ctx) => {
      if (!config.enabled) return;
      try {
        const prompt = (event as { prompt?: unknown }).prompt;
        if (typeof prompt === "string") pendingPrompt = prompt;
        const current = refresh(ctx.cwd);
        turnTools = [];
        turnFiles = [];
        const budget = config.budgetTokens;
        const block = buildMemoryBlock({
          doc: current.doc,
          lessons: current.lessons,
          paths: current.paths,
          budgetTokens: budget,
        });
        if (block === "") return;
        const withSections = event.systemPromptOptions as { sections?: Record<string, string> };
        withSections.sections = { ...(withSections.sections ?? {}) };
        withSections.sections[MEMORY_SECTION] = block;
      } catch {
        // Never break a prompt because memory could not be read.
      }
    });

    qronos.on("tool_execution_start", async (event) => {
      if (!config.enabled) return;
      try {
        turnTools.push(event.toolName);
        for (const file of toolFileArgs(event.args)) turnFiles.push(file);
      } catch {
        // Ignore odd argument shapes.
      }
    });

    qronos.on("turn_end", async (event, ctx) => {
      if (!config.enabled) return;
      try {
        const message = event.message as { content?: unknown; stopReason?: string } | undefined;
        const answer = message ? assistantText(message.content) : "";
        const failed =
          message?.stopReason === "error" || (event.toolResults ?? []).some((result) => result.isError === true);
        const entry = buildJournalEntry(
          {
            prompt: pendingPrompt,
            answer,
            tools: turnTools,
            files: turnFiles,
            outcome: failed ? "error" : "ok",
            at: now(),
          },
          ctx.cwd,
        );
        if (!entry) return;
        appendJournal(ensureLive(ctx.cwd).paths, entry);
        const state = readState(live!.paths);
        writeState(live!.paths, { ...state, turns: state.turns + 1 });
      } catch {
        // Journaling is best-effort.
      } finally {
        // The prompt is NOT cleared here: one user prompt can produce several
        // turns (tool calls, retries), and each of those rows belongs to it.
        // It is replaced at the next before_agent_start.
        turnTools = [];
        turnFiles = [];
      }
    });

    qronos.registerTool({
      name: MEMORY_TOOL_NAME,
      label: "Learn",
      description:
        "Save one durable lesson about this project for future sessions. Use it when you learn something that will stay true (a build flag, a trap, a convention the user wants). Do not save secrets, file contents, or one-off facts.",
      parameters: Type.Object({
        lesson: Type.String({ description: "One short sentence, under 400 characters." }),
      }),
      defaultActive: true,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (!config.enabled) {
          return {
            content: [{ type: "text", text: "Memory is turned off (QRONOS_MEMORY=0); nothing was saved." }],
            details: { saved: false, reason: "disabled" },
          };
        }
        const current = ensureLive(ctx.cwd);
        const lessons = current.lessons;
        const result = addLesson(lessons, params.lesson, now());
        if (!result.added) {
          const why = result.reason === "duplicate" ? "That lesson is already known." : "The lesson was empty.";
          return { content: [{ type: "text", text: why }], details: { saved: false, reason: result.reason } };
        }
        if (!writeAtomic(current.paths.lessons, renderLessons(result.lessons))) {
          return {
            content: [{ type: "text", text: "Could not write the lesson file; the lesson was not saved." }],
            details: { saved: false, reason: "write-failed" },
            isError: true,
          };
        }
        live = { ...current, lessons: result.lessons };
        updateStatus(ctx, live);
        return {
          content: [{ type: "text", text: `Saved. ${result.lessons.length} lesson(s) now known for this project.` }],
          details: { saved: true, count: result.lessons.length },
        };
      },
    });

    qronos.registerCommand("memory", {
      description: "Show, sync or clear what this project has learned (view | stats | sync | forget | add | clear)",
      handler: async (args, ctx) => {
        const [action = "view", ...rest] = args.trim().split(/\s+/).filter(Boolean);
        if (!config.enabled) {
          ctx.ui.notify("Memory is off. Remove QRONOS_MEMORY=0 to turn it back on.", "info");
          return;
        }
        const current = refresh(ctx.cwd);
        switch (action) {
          case "view": {
            const block = buildMemoryBlock({
              doc: current.doc,
              lessons: current.lessons,
              paths: current.paths,
              budgetTokens: config.budgetTokens,
            });
            if (block === "") {
              ctx.ui.notify(
                `Nothing learned about ${current.projectName} yet. Work a few turns, then run /memory sync. Folder: ${current.paths.root}`,
                "info",
              );
              return;
            }
            ctx.ui.notify(block, "info");
            return;
          }
          case "stats": {
            const state = readState(current.paths);
            const journal = readJournal(current.paths);
            const pending = journal.filter((entry) => entry.seq > state.lastSeq).length;
            const lines = [
              `Project: ${current.projectName}`,
              `Folder: ${current.paths.root}`,
              `Items: ${docItemCount(current.doc)} in the document, ${current.lessons.length} lesson(s)`,
              `Synced: ${state.syncs} time(s), last ${state.lastSyncAt > 0 ? new Date(state.lastSyncAt).toISOString().replace("T", " ").slice(0, 19) : "never"}`,
              `Journal: ${pending} turn(s) waiting, ${journal.length} kept`,
              `Budget: about ${config.budgetTokens} tokens per prompt`,
            ];
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }
          case "sync": {
            ctx.ui.notify(await runSync(ctx, true), "info");
            return;
          }
          case "add": {
            const text = rest.join(" ").trim();
            if (text === "") {
              ctx.ui.notify("Usage: /memory add <lesson>", "warning");
              return;
            }
            const result = addLesson(current.lessons, text, now());
            if (!result.added) {
              ctx.ui.notify(result.reason === "duplicate" ? "Already known." : "Nothing to add.", "info");
              return;
            }
            if (!writeAtomic(current.paths.lessons, renderLessons(result.lessons))) {
              ctx.ui.notify("Could not write the lesson file.", "error");
              return;
            }
            live = { ...current, lessons: result.lessons };
            updateStatus(ctx, live);
            ctx.ui.notify(`Saved. ${result.lessons.length} lesson(s) known.`, "info");
            return;
          }
          case "forget": {
            const text = rest.join(" ").trim();
            if (text === "") {
              ctx.ui.notify("Usage: /memory forget <words from the lesson>", "warning");
              return;
            }
            const result = forgetLesson(current.lessons, text);
            if (result.removed === 0) {
              ctx.ui.notify("No lesson matched.", "info");
              return;
            }
            writeAtomic(current.paths.lessons, renderLessons(result.lessons));
            live = { ...current, lessons: result.lessons };
            updateStatus(ctx, live);
            ctx.ui.notify(`Forgot ${result.removed} lesson(s).`, "info");
            return;
          }
          case "clear": {
            const ok = await ctx.ui.confirm(
              "Clear project memory?",
              `This deletes ${current.paths.root} (document, lessons, journal). It cannot be undone.`,
            );
            if (!ok) return;
            if (!acquireLock(current.paths)) {
              ctx.ui.notify("A sync is running; try again in a moment.", "warning");
              return;
            }
            try {
              rewriteJournal(current.paths, []);
              writeAtomic(current.paths.doc, renderDoc(parseDoc(""), now()));
              writeAtomic(current.paths.summary, "");
              writeAtomic(current.paths.lessons, "");
              writeState(current.paths, { ...readState(current.paths), lastSeq: 0, lastSyncAt: 0, syncs: 0 });
              live = refresh(ctx.cwd);
              updateStatus(ctx, live);
              ctx.ui.notify("Project memory cleared.", "info");
            } finally {
              releaseLock(current.paths);
            }
            return;
          }
          default:
            ctx.ui.notify(
              "Usage: /memory [view|stats|sync|add <lesson>|forget <text>|clear]",
              "warning",
            );
        }
      },
    });
  };

  return { name: "qronos-memory", factory: extension };
}

/** Token estimate helper exported for the status line in tests. */
export { approxTokens };
