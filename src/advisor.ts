// Advisor extension: review each finished turn with a cheap model and hand the
// notes to the next request as a system section.
//
// The review runs in the background. The extension never awaits it inside the
// turn_end handler, because a slow reviewer must not make the main agent look
// slow; if the notes are not ready when the next request starts, they are used
// one turn later (or dropped when a new one replaces them).
import type { ExtensionAPI, ExtensionContext, ExtensionFactory, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Api, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import {
  ADVISOR_SECTION,
  ADVISOR_SYSTEM_PROMPT,
  advisorStatus,
  buildReviewPrompt,
  formatAdvisorSection,
  parseAdvisorAdvice,
  shouldReview,
  type AdvisorConfig,
} from "./advisor-core";
import { CLI_VERSION } from "./version";

export const ADVISOR_STATUS_KEY = "qronos-advisor";

/** Hard cap on one review, so a hung provider cannot pile up work. */
export const REVIEW_TIMEOUT_MS = 45_000;

export interface AdvisorOptions {
  config?: AdvisorConfig;
  /** Injected for tests; defaults to the real completion helper. */
  complete?: (model: Model<Api>, prompt: string, auth: { apiKey?: string; headers?: Record<string, string> }) => Promise<string>;
}

/** Resolve the reviewer model: explicit selector, else the session model. */
export function resolveAdvisorModel(
  config: AdvisorConfig,
  sessionModel: Model<Api> | undefined,
  modelRegistry?: ModelRegistry,
): Model<Api> | undefined {
  const wanted = config.model?.trim().toLowerCase();
  if (!wanted) return sessionModel;
  if (modelRegistry) {
    if (sessionModel && modelRegistry.find(sessionModel.provider, config.model!)) {
      return modelRegistry.find(sessionModel.provider, config.model!) ?? sessionModel;
    }
    const match = modelRegistry
      .getModelsOfType("chat")
      .find((m) => m.id?.toLowerCase() === wanted || m.id?.toLowerCase().includes(wanted));
    if (match) return match;
  }
  // Unknown selector: keep the advisor alive on the session model instead of
  // silently switching it off. The status line says which model is in use.
  return sessionModel;
}

async function defaultComplete(
  model: Model<Api>,
  prompt: string,
  auth: { apiKey?: string; headers?: Record<string, string> },
): Promise<string> {
  const response = await completeSimple(
    model as Model<any>,
    {
      systemPrompt: ADVISOR_SYSTEM_PROMPT,
      messages: [{ role: "user", timestamp: Date.now(), content: [{ type: "text", text: prompt }] }],
    },
    { apiKey: auth.apiKey, headers: auth.headers },
  );
  const content = (response as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: string; text: string } => !!block && typeof block === "object" && (block as { type?: string }).type === "text")
    .map((block) => block.text)
    .join("\n");
}

export function createAdvisorExtension(options: AdvisorOptions = {}): ExtensionFactory | undefined {
  const config: AdvisorConfig = { ...(options.config ?? { enabled: false, everyTurns: 1, maxNotes: 4 }) };
  if (!config.enabled) return undefined;

  const complete = options.complete ?? defaultComplete;
  let pendingSection: string | undefined;
  let reviewing = false;

  const extension: ExtensionFactory = (qronos: ExtensionAPI) => {
    qronos.on("session_start", async (_event, ctx) => {
      ctx.ui.setStatus(ADVISOR_STATUS_KEY, advisorStatus(config));
    });

    qronos.on("turn_end", async (event, ctx: ExtensionContext) => {
      if (!shouldReview(event.turnIndex, config)) return;
      if (reviewing) return; // one review at a time; skip rather than queue

      const assistantText = textOf(event.message);
      if (!assistantText.trim()) return;

      const model = resolveAdvisorModel(config, ctx.model, ctx.modelRegistry);
      if (!model) return;

      const toolsUsed = (event.toolResults ?? [])
        .map((result) => (result as { toolName?: string }).toolName)
        .filter((name): name is string => typeof name === "string");

      reviewing = true;
      const prompt = buildReviewPrompt({ assistantText, toolsUsed });
      const run = async () => {
        const auth = await resolveAuth(ctx, model);
        const timeout = new AbortController();
        const timer = setTimeout(() => timeout.abort(), REVIEW_TIMEOUT_MS);
        try {
          const reply = await withTimeout(complete(model, prompt, auth), REVIEW_TIMEOUT_MS);
          const advice = parseAdvisorAdvice(reply, config.maxNotes);
          const section = formatAdvisorSection(advice);
          if (section) {
            pendingSection = section;
            ctx.ui.setStatus(
              ADVISOR_STATUS_KEY,
              advice.blocker ? "advisor: blocker found" : `advisor: ${advice.notes.length} note(s)`,
            );
          }
        } catch {
          // A failed review must never surface as an error in the user's session.
        } finally {
          clearTimeout(timer);
          reviewing = false;
        }
      };
      // Deliberately not awaited: the turn must finish at normal speed.
      void run();
    });

    qronos.on("before_agent_start", async (event) => {
      if (!pendingSection) return;
      const target = event.systemPromptOptions as { sections?: Record<string, string> };
      target.sections = { ...(target.sections ?? {}) };
      target.sections[ADVISOR_SECTION] = pendingSection;
      pendingSection = undefined;
    });
  };

  return extension;
}

async function resolveAuth(
  ctx: ExtensionContext,
  model: Model<Api>,
): Promise<{ apiKey?: string; headers?: Record<string, string> }> {
  try {
    const auth = (await ctx.modelRegistry.getApiKeyAndHeaders(model)) as {
      apiKey?: string;
      headers?: Record<string, string>;
    };
    return {
      apiKey: auth.apiKey,
      headers: { ...(auth.headers ?? {}), "x-client-version": CLI_VERSION, "x-qronos-client": "cli" },
    };
  } catch {
    return {};
  }
}

/** Reject after `ms` so a stuck request cannot hold the reviewer forever. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`advisor review timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Flatten an assistant message into plain text. */
export function textOf(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: string; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .join("");
}
