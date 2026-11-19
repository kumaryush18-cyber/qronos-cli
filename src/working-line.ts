// Claude-Code-style working line, drawn as its OWN row above the editor.
//
// Why not pi's built-in indicator: pi draws it inside the editor border
// (isEmbeddedStatus path in interactive-mode), which makes the spinner and the
// token count look like part of the input box. Here the line is a widget with
// placement "aboveEditor", so it sits outside the border, above the ad box.
//
// Animation, copied from how Claude Code (and its pi port pi-claude-shimmer,
// 1.0.8) behave:
//   glyphs:  · ✢ ✳ ✶ ✻ ✽   played forward then backward (ping-pong), 120 ms
//   line:    ✢ Crafting…  (32s · ↓ 1.2k tokens · thinking)
//   arrow:   ↑ while the request is being sent, ↓ once tokens arrive
//   verb:    a random word from Claude Code's own list, re-picked every 6 s
//            so a long run keeps moving (Claude Code keeps one per turn)
//   shimmer: a light-orange band flows through the verb every 3 s
//   done:    ✻ Churned for 2m 5s  — one row under the answer, in LIGHT orange,
//            so it reads as a summary and not as work
//   thinking/tool labels reset per model call, the TOKEN COUNT does not.
import type { ExtensionAPI, InlineExtension, Theme } from "@earendil-works/pi-coding-agent";
import { lightOrangeAnsi, mutedAnsi, orangeAnsi, RESET, SHIMMER_PERIOD_MS, shimmerPhase, shimmerText } from "./shimmer";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { formatTokenCount, OutputTokenCounter } from "./thinking-meter";

export const WORKING_LINE_WIDGET_ID = "qronos-working-line";

/** Claude Code's spinner set, in order. */
export const GLYPHS = ["·", "✢", "✳", "✶", "✻", "✽"] as const;

/**
 * Forward, then backward without repeating the ends:
 * · ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢ — the ping-pong Claude Code and pi-claude-shimmer use.
 */
export const SPINNER_FRAMES: string[] = [...GLYPHS, ...[...GLYPHS].reverse().slice(1, -1)];

/** Glyph speed. Claude Code is ~120 ms; 150 ms reads calmer in a terminal. */
export const FRAME_MS = 150;

/** The verb changes this often while a run is active. */
export const VERB_ROTATE_MS = 6_000;

/** Glyph of the line that stays after the run ends. */
export const DONE_GLYPH = "✻";

/** Elapsed time only appears once a turn has been running this long. */
export const ELAPSED_AFTER_MS = 30_000;

/** Requesting uses ↑, everything else ↓ (Claude Code asks with ↑, answers with ↓). */
export const ARROW_REQUESTING = "↑";
export const ARROW_WORKING = "↓";

// Colours and the shimmer live in shimmer.ts, shared with the header, so both
// animations use the same orange, the same light orange and the same 3 s speed.
export { lightOrangeAnsi, mutedAnsi, orangeAnsi, RESET, SHIMMER_BAND, SHIMMER_PERIOD_MS, shimmerText } from "./shimmer";

/**
 * One verb per turn, like Claude Code. This is Claude Code's own leaked spinner
 * list (~187 gerunds, v2.1.x); it picks one at random per turn and keeps it for
 * the whole turn. Playful words are the point — "Galloping", "Gitifying".
 */
export const VERBS = [
  "Accomplishing", "Actioning", "Actualizing", "Architecting", "Baking", "Beaming",
  "Beboppin'", "Befuddling", "Billowing", "Blanching", "Bloviating", "Boogieing",
  "Boondoggling", "Booping", "Bootstrapping", "Brewing", "Bunning", "Burrowing",
  "Calculating", "Canoodling", "Caramelizing", "Cascading", "Catapulting", "Cerebrating",
  "Channeling", "Channelling", "Choreographing", "Churning", "Clauding", "Coalescing",
  "Cogitating", "Combobulating", "Composing", "Computing", "Concocting", "Considering",
  "Contemplating", "Cooking", "Crafting", "Creating", "Crunching", "Crystallizing",
  "Cultivating", "Deciphering", "Deliberating", "Determining", "Dilly-dallying",
  "Discombobulating", "Doing", "Doodling", "Drizzling", "Ebbing", "Effecting",
  "Elucidating", "Embellishing", "Enchanting", "Envisioning", "Evaporating", "Fermenting",
  "Fiddle-faddling", "Finagling", "Flambéing", "Flibbertigibbeting", "Flowing",
  "Flummoxing", "Fluttering", "Forging", "Forming", "Frolicking", "Frosting",
  "Gallivanting", "Galloping", "Garnishing", "Generating", "Gesticulating", "Germinating",
  "Gitifying", "Grooving", "Gusting", "Harmonizing", "Hashing", "Hatching", "Herding",
  "Honking", "Hullaballooing", "Hyperspacing", "Ideating", "Imagining", "Improvising",
  "Incubating", "Inferring", "Infusing", "Ionizing", "Jitterbugging", "Julienning",
  "Kneading", "Leavening", "Levitating", "Lollygagging", "Manifesting", "Marinating",
  "Meandering", "Metamorphosing", "Misting", "Moonwalking", "Moseying", "Mulling",
  "Mustering", "Musing", "Nebulizing", "Nesting", "Newspapering", "Noodling",
  "Nucleating", "Orbiting", "Orchestrating", "Osmosing", "Perambulating", "Percolating",
  "Perusing", "Philosophising", "Photosynthesizing", "Pollinating", "Pondering",
  "Pontificating", "Pouncing", "Precipitating", "Prestidigitating", "Processing",
  "Proofing", "Propagating", "Puttering", "Puzzling", "Quantumizing", "Razzle-dazzling",
  "Razzmatazzing", "Recombobulating", "Reticulating", "Roosting", "Ruminating",
  "Sautéing", "Scampering", "Schlepping", "Scurrying", "Seasoning", "Shenaniganing",
  "Shimmying", "Simmering", "Skedaddling", "Sketching", "Slithering", "Smooshing",
  "Sock-hopping", "Spelunking", "Spinning", "Sprouting", "Stewing", "Sublimating",
  "Swirling", "Swooping", "Symbioting", "Synthesizing", "Tempering", "Thinking",
  "Thundering", "Tinkering", "Tomfoolering", "Topsy-turvying", "Transfiguring",
  "Transmuting", "Twisting", "Undulating", "Unfurling", "Unravelling", "Vibing",
  "Waddling", "Wandering", "Warping", "Whatchamacalliting", "Whirlpooling", "Whirring",
  "Whisking", "Wibbling", "Working", "Wrangling", "Zesting", "Zigzagging",
] as const;

/**
 * Closing words, in Claude Code's past-tense style ("Churned for 2m 5s").
 * A fixed, small list keeps the line short and readable.
 */
export const DONE_VERBS = [
  "Baked", "Brewed", "Churned", "Cogitated", "Cooked", "Crunched", "Forged",
  "Galloped", "Gitified", "Marinated", "Noodled", "Pondered", "Sautéed",
  "Simmered", "Spelunked", "Tinkered", "Worked", "Wrangled", "Zested",
] as const;

export type WorkingPhase = "requesting" | "thinking" | "responding" | "tool";

/** Picks the verb shown for one turn. Injected RNG for tests. */
export function pickVerb(random: () => number = Math.random): string {
  const index = Math.floor(random() * VERBS.length) % VERBS.length;
  return VERBS[index]!;
}

/**
 * A new verb, never the same one twice in a row (a repeat reads as "frozen").
 * Falls back to the same word only if the RNG keeps returning it.
 */
export function pickVerbDifferentFrom(current: string, random: () => number = Math.random): string {
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = pickVerb(random);
    if (candidate !== current) return candidate;
  }
  return pickVerb(random);
}

/** "12s", "1m 3s", "1h 2m" — Claude Code's compact elapsed style. */
export function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export interface WorkingLineInput {
  /** Index into SPINNER_FRAMES. */
  frame: number;
  verb: string;
  phase: WorkingPhase;
  /** Output tokens so far in this turn (already counted, not estimated here). */
  tokens: number;
  /** Milliseconds since the user pressed send. */
  elapsedMs: number;
  /** 0 -> 1 for one shimmer sweep; omit for a plain orange verb. */
  shimmerPhase?: number;
}

/** Visible length, ignoring ANSI escapes. */
export function visibleLength(text: string): number {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").length;
}

/** Cut a coloured line to `width` without breaking the escape sequences. */
export function truncateToWidth(text: string, width: number): string {
  if (width <= 0) return "";
  if (visibleLength(text) <= width) return text;
  const hasAnsi = text.includes("\x1b[");
  const plain = text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
  const cut = plain.slice(0, Math.max(0, width - 1)) + "…";
  return hasAnsi ? `${cut}${RESET}` : cut;
}

/**
 * Builds the whole line, e.g.
 *   ✢ Crafting… (32s · ↓ 1.2k tokens · thinking)
 * Order of the parts follows Claude Code: elapsed, tokens, state.
 */
export function buildWorkingLine(input: WorkingLineInput): string {
  const glyph = SPINNER_FRAMES[((input.frame % SPINNER_FRAMES.length) + SPINNER_FRAMES.length) % SPINNER_FRAMES.length]!;
  const arrow = input.phase === "requesting" ? ARROW_REQUESTING : ARROW_WORKING;
  const parts: string[] = [];
  if (input.elapsedMs >= ELAPSED_AFTER_MS) parts.push(formatElapsed(input.elapsedMs));
  const count = formatTokenCount(input.tokens);
  if (count && input.tokens > 0) parts.push(`${arrow} ${count} tokens`);
  if (input.phase === "thinking") parts.push("thinking");
  if (input.phase === "tool") parts.push("tool");
  const orange = orangeAnsi();
  const body = parts.length > 0 ? ` ${mutedAnsi()}(${parts.join(" · ")})${RESET}` : "";
  // The verb is orange too, not just the glyph: with a one-character glyph the
  // line read as grey and the colour was easy to miss.
  const word =
    input.shimmerPhase === undefined
      ? `${orange}${input.verb}…${RESET}`
      : shimmerText(`${input.verb}…`, input.shimmerPhase);
  return `${orange}${glyph}${RESET} ${word}${body}`;
}

/**
 * The summary line that stays after the run ends, e.g.
 *   ✻ Churned for 2m 5s
 *
 * Light orange, not the working line's brand orange: the eye should read it as
 * "finished", not as "working".
 */
export function buildDoneLine(verb: string, elapsedMs: number): string {
  return `${lightOrangeAnsi()}${DONE_GLYPH} ${verb} for ${formatElapsed(elapsedMs)}${RESET}`;
}

/** The finished state is one row: the summary line only. */
export function buildDoneRows(verb: string, elapsedMs: number, width: number): string[] {
  return [truncateToWidth(buildDoneLine(verb, elapsedMs), width)];
}

/** Picks the closing word. Injected RNG for tests. */
export function pickDoneVerb(random: () => number = Math.random): string {
  const index = Math.floor(random() * DONE_VERBS.length) % DONE_VERBS.length;
  return DONE_VERBS[index]!;
}

export interface CreateWorkingLineOptions {
  now?: () => number;
  random?: () => number;
  /** Frame interval. Tests shrink it. */
  frameMs?: number;
}

/**
 * Draws the working line above the ad box, outside the input border, for the
 * whole run (prompt -> final answer), and keeps pi's own inner indicator hidden.
 */
export function createWorkingLineExtension(opts: CreateWorkingLineOptions = {}): InlineExtension {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const frameMs = opts.frameMs ?? FRAME_MS;

  return {
    name: "qronos-working-line",
    factory(api: ExtensionAPI) {
      let tui: TUI | undefined;
      let timer: ReturnType<typeof setInterval> | null = null;
      let registered = false;
      let running = false;
      let verb = pickVerb(random);
      let verbAt = 0;
      let startedAt = 0;
      let done: { verb: string; elapsedMs: number } | null = null;
      let frame = 0;
      let phase: WorkingPhase = "requesting";
      const counter = new OutputTokenCounter();

      const line = (): string => {
        if (!running) return "";
        const elapsedMs = now() - startedAt;
        return buildWorkingLine({
          frame,
          verb,
          phase,
          tokens: counter.tokens(),
          elapsedMs,
          // Clock-based, not run-based, so the verb glows in step with the header.
          shimmerPhase: shimmerPhase(),
        });
      };

      let cached: string[] = [];
      let cachedLine = "";
      let cachedWidth = -1;
      const component: Component = {
        render: (width: number) => {
          const text = line();
          const key = done ? `done:${done.verb}:${done.elapsedMs}` : text;
          if (key === cachedLine && width === cachedWidth) return cached;
          cachedLine = key;
          cachedWidth = width;
          if (done) cached = buildDoneRows(done.verb, done.elapsedMs, width);
          else cached = text ? [truncateToWidth(text, width)] : [];
          return cached;
        },
        invalidate: () => {
          cachedLine = "";
          cachedWidth = -1;
        },
      };

      const repaint = (): void => {
        try {
          tui?.requestRender();
        } catch {
          // Terminal gone or shutting down: nothing to repaint.
        }
      };

      const registerWidget = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]): void => {
        if (registered) return;
        registered = true;
        try {
          ctx.ui.setWidget(
            WORKING_LINE_WIDGET_ID,
            (widgetTui: TUI, _theme: Theme) => {
              tui = widgetTui;
              return component;
            },
            { placement: "aboveEditor" },
          );
        } catch {
          registered = false;
        }
      };

      const tick = (): void => {
        if (!running) return;
        frame++;
        if (now() - verbAt >= VERB_ROTATE_MS) {
          verb = pickVerbDifferentFrom(verb, random);
          verbAt = now();
        }
        repaint();
      };

      const startRun = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]): void => {
        registerWidget(ctx);
        done = null;
        running = true;
        verb = pickVerb(random);
        startedAt = now();
        verbAt = startedAt;
        frame = 0;
        phase = "requesting";
        // One run = one count: from the moment the prompt is sent until the
        // final answer, across every model call and every tool.
        counter.reset();
        // pi's own line lives inside the editor border; hide it while ours runs.
        try {
          ctx.ui.setWorkingVisible(false);
        } catch {
          // Old UI without the toggle: our line still shows, pi's also shows.
        }
        if (!timer) timer = setInterval(tick, frameMs);
        repaint();
      };

      const endRun = (ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1]): void => {
        // Keep a closing line so the user sees how long the run took, the same
        // way Claude Code leaves "✻ Churned for 2m 5s" in the transcript.
        // It is replaced by the next run, or by session_shutdown.
        done = running ? { verb: pickDoneVerb(random), elapsedMs: now() - startedAt } : null;
        running = false;
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        try {
          ctx.ui.setWorkingVisible(true);
        } catch {
          // ignore
        }
        repaint();
      };

      api.on("session_start", (_event, ctx) => {
        // Registered early so the line is inserted BEFORE the ad widget and
        // therefore renders above it.
        registerWidget(ctx);
        repaint();
      });
      api.on("agent_start", (_event, ctx) => startRun(ctx));
      api.on("agent_end", (_event, ctx) => endRun(ctx));

      api.on("message_start", (event, ctx) => {
        const message = (event as { message?: { role?: string } }).message;
        if (message?.role !== "assistant") return;
        counter.messageStart(message);
        phase = "thinking";
        repaint();
        void ctx;
      });
      api.on("message_update", (event, ctx) => {
        const update = event as {
          message?: { role?: string; usage?: { output?: number } };
          assistantMessageEvent?: { type?: string; delta?: unknown };
        };
        if (update.message?.role !== "assistant") return;
        counter.messageUpdate(update.message, update.assistantMessageEvent);
        const type = update.assistantMessageEvent?.type ?? "";
        phase = type.startsWith("thinking") ? "thinking" : type.startsWith("text") ? "responding" : phase;
        repaint();
        void ctx;
      });
      api.on("message_end", (event, ctx) => {
        const message = (event as { message?: { role?: string } }).message;
        if (message?.role !== "assistant") return;
        // Freeze this call's count into the run total. The next model call in
        // the same run ADDS to it — only agent_start starts again from zero.
        counter.messageEnd(message);
        // Do not switch to "tool" here: the model may have just finished for
        // good. tool_execution_start is what marks a tool actually running.
        repaint();
        void ctx;
      });

      // Tool runs between model calls: the label changes, the count does not.
      api.on("tool_execution_start", (_event, ctx) => {
        phase = "tool";
        repaint();
        void ctx;
      });
      api.on("tool_execution_end", (_event, ctx) => {
        phase = "thinking";
        repaint();
        void ctx;
      });

      api.on("session_shutdown", () => {
        if (timer) {
          clearInterval(timer);
          timer = null;
        }
        running = false;
      });
    },
  };
}
