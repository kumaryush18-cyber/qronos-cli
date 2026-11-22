// The workflow panel, part two: the box, the colour, the keys.
//
// Variant A, the same shape as the Agent Hub: a floating panel in the middle of
// the screen, opened with Alt+W or `/workflows panel`. It only *reads* the job
// manager, so closing it can never lose a run, and every action it offers
// (pause, resume, stop) is also a `/workflows` command. A panel nobody opens is
// never the only way to do something.
//
// Two details that matter:
//   1. The ticker runs only while something is live. A finished run does not keep
//      the terminal redrawing 8 times a second.
//   2. The shimmer is the same 3 s pale-orange band as the header and the working
//      line, painted on the one line that is doing work. Reusing it makes the
//      panel feel like part of the CLI rather than a window glued on.
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { WorkflowJobManager } from "./workflow-jobs";
import {
  buildPanelLines,
  moveIndex,
  toPanelJob,
  type PanelJobView,
  type PanelLine,
  type PanelLineStyle,
  type PanelMode,
} from "./workflow-panel-view";
import { formatTokens } from "./workflow-types";
import { DARK_RED, PHASE_BLUE, RUNNING, BRIGHT_GREEN } from "./workflow-glyphs";
import { bandMixAt, glowChar, shimmerPhase, BRAND_ORANGE, SHIMMER_BAND } from "./shimmer";
import { foregroundAnsi, getTerminalColorMode, rgbColor } from "@earendil-works/pi-tui";

const PANEL_WIDTH = 74;
const PANEL_HEIGHT = 26;
/** A frame every 120 ms: smooth enough for the band, cheap enough to leave on. */
export const PANEL_FRAME_MS = 120;

export interface WorkflowPanelOptions {
  manager: WorkflowJobManager;
  theme: Theme;
  done: () => void;
  requestRender?: () => void;
  width?: number;
  height?: number;
  now?: () => number;
  frameMs?: number;
}

/** A job the panel can show: the newest running one, else the newest of all. */
function pickJob(manager: WorkflowJobManager, lastSeenId?: string): PanelJobView | undefined {
  const now = Date.now();
  const active = manager.active();
  const chosen = (lastSeenId ? manager.get(lastSeenId) : undefined) ?? active[0] ?? manager.list()[0];
  return chosen ? toPanelJob(chosen, now) : undefined;
}

export class WorkflowPanel {
  private readonly manager: WorkflowJobManager;
  private readonly theme: Theme;
  private readonly done: () => void;
  private readonly requestRender: () => void;
  private readonly width: number;
  readonly height: number;
  private readonly now: () => number;
  private readonly frameMs: number;

  selectedAgent = 0;
  /** Which job to look at, by id, so a list that reorders cannot swap rows. */
  jobId?: string;
  mode: PanelMode = "list";
  /** Frames drawn so far, for the shimmer. */
  private frame = 0;
  private ticker?: ReturnType<typeof setInterval>;

  constructor(options: WorkflowPanelOptions) {
    this.manager = options.manager;
    this.theme = options.theme;
    this.done = options.done;
    this.requestRender = options.requestRender ?? (() => {});
    this.width = options.width ?? PANEL_WIDTH;
    this.height = options.height ?? PANEL_HEIGHT;
    this.now = options.now ?? Date.now;
    this.frameMs = options.frameMs ?? PANEL_FRAME_MS;
    this.startTicker();
  }

  dispose(): void {
    this.stopTicker();
  }

  invalidate(): void {}

  /** The job under the cursor right now, or the newest live one. */
  job(): PanelJobView | undefined {
    return pickJob(this.manager, this.jobId);
  }

  get live(): boolean {
    return this.manager.active().length > 0;
  }

  render(width: number): string[] {
    const panelWidth = Math.max(30, Math.min(this.width, width));
    const job = this.job();
    const phase = this.frame * (this.frameMs / 3_000);
    const lines = buildPanelLines({
      jobs: this.manager.list().map((entry) => toPanelJob(entry, this.now())),
      job,
      selectedAgent: this.selectedAgent,
      mode: this.mode,
      width: panelWidth,
      now: this.now(),
      height: this.height,
      phase,
    });
    const body = lines.map((line) => this.renderLine(line, panelWidth, phase));
    const footer = this.footer(job, panelWidth);
    const footerText = footer.map((line) => truncateToWidth(this.colour(line.style, line.text), panelWidth - 2, "…", false));
    return this.box([...body, ...footerText], panelWidth);
  }

  handleInput(data: string): void {
    const job = this.job();
    if (this.mode === "agent") {
      if (matchesKey(data, "escape")) {
        this.mode = "list";
        this.requestRender();
        return;
      }
      if (matchesKey(data, "up")) {
        this.selectedAgent = moveIndex(this.selectedAgent, job?.agents.length ?? 0, -1);
        this.requestRender();
        return;
      }
      if (matchesKey(data, "down")) {
        this.selectedAgent = moveIndex(this.selectedAgent, job?.agents.length ?? 0, 1);
        this.requestRender();
        return;
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const jobs = this.manager.list();
      if (jobs.length > 1) {
        const current = Math.max(0, jobs.findIndex((entry) => entry.id === job?.id));
        const next = jobs[moveIndex(current, jobs.length, matchesKey(data, "up") ? -1 : 1)];
        if (next) this.jobId = next.id;
      } else if (matchesKey(data, "up")) {
        this.selectedAgent = moveIndex(this.selectedAgent, job?.agents.length ?? 0, -1);
      } else {
        this.selectedAgent = moveIndex(this.selectedAgent, job?.agents.length ?? 0, 1);
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, "return")) {
      if (job && job.agents.length > 0) {
        this.mode = "agent";
        this.requestRender();
      }
      return;
    }
    if (matchesKey(data, "space")) {
      if (!job) return;
      if (job.state === "running") this.manager.pause(job.id);
      else if (job.state === "paused") this.manager.resume(job.id);
      this.startTicker();
      this.requestRender();
      return;
    }
    if (data === "x" || data === "X") {
      if (!job) return;
      if (job.state === "running" || job.state === "paused" || job.state === "queued") this.manager.cancel(job.id);
      this.requestRender();
      return;
    }
    if (data === "r" || data === "R") {
      // Replay a finished or stopped run from its journal, without leaving the panel.
      if (!job || this.live) return;
      try {
        const replay = this.manager.resumeFrom(job.id);
        this.jobId = replay.id;
        this.startTicker();
      } catch {
        // Nothing saved: the panel just keeps showing what it had.
      }
      this.requestRender();
    }
  }

  /** One frame of redraw per tick, and only while a run is live. */
  private startTicker(): void {
    this.stopTicker();
    if (!this.live) return;
    this.ticker = setInterval(() => {
      this.frame += 1;
      if (!this.live) {
        // The run finished while the panel was open: draw one last frame, then
        // stop, so a terminal left open is not redrawn forever.
        this.stopTicker();
        this.requestRender();
        return;
      }
      this.requestRender();
    }, this.frameMs);
    const asTimer = this.ticker as unknown as { unref?: () => void };
    asTimer.unref?.();
  }

  private stopTicker(): void {
    if (this.ticker === undefined) return;
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  /** The last line: which run, and whether its record is on disk. */
  private footer(job: PanelJobView | undefined, width: number): PanelLine[] {
    if (!job) return [];
    const where = job.journalPath ? "journal on disk" : "no journal";
    const resumed = job.resumedFrom ? ` · replayed from ${job.resumedFrom}` : "";
    return [{ text: truncateToWidth(`  ${job.id} · ${where}${resumed}`, width - 2, "…", false), style: "hint" }];
  }

  /**
   * Colour one line.
   *
   * The active phase and the running agents get the shimmer: the same pale orange
   * band that flows through the header, so the moving light always means "work is
   * happening right now" everywhere in the CLI.
   */
  private renderLine(line: PanelLine, width: number, phase: number): string {
    const text = line.text;
    // The title glows orange like the CLI header, and the working rows get the
    // same band: one light, one meaning.
    if (line.style === "title" || line.style === "phase-active" || line.style === "agent-running") {
      return truncateToWidth(this.shimmer(text, phase), width - 2, "…", false);
    }
    return truncateToWidth(this.colour(line.style, text), width - 2, "…", false);
  }

  /** Paint a line with the shared 3 s band. */
  private shimmer(text: string, phase: number): string {
    const chars = [...text];
    const span = chars.length + SHIMMER_BAND;
    let out = "";
    for (let index = 0; index < chars.length; index += 1) {
      const mix = bandMixAt(index, span, phase);
      out += glowChar(chars[index]!, BRAND_ORANGE, mix, mix > 0.5);
    }
    return out;
  }

  private colour(style: PanelLineStyle, text: string): string {
    const theme = this.theme as unknown as { fg?: (slot: string, text: string) => string };
    const paint = (slot: string, fallback: string) => {
      try {
        return theme.fg ? theme.fg(slot, text) : fallback;
      } catch {
        return fallback;
      }
    };
    const ansi = (colour: ReturnType<typeof rgbColor>) => {
      const code = foregroundAnsi(colour, getTerminalColorMode());
      return code ? `${code}${text}\x1b[0m` : text;
    };
    switch (style) {
      case "title":
        return ansi(PHASE_BLUE);
      case "job-selected":
        return ansi(PHASE_BLUE);
      case "phase":
        return ansi(PHASE_BLUE);
      case "phase-failed":
      case "agent-bad":
        return ansi(DARK_RED);
      case "agent-ok":
        return ansi(BRIGHT_GREEN);
      case "agent-replay":
        return ansi(PHASE_BLUE);
      case "detail":
        return paint("muted", text);
      case "hint":
        return paint("muted", text);
      case "empty":
        return text;
      default:
        return text;
    }
  }

  private box(lines: string[], width: number): string[] {
    const theme = this.theme as unknown as { fg?: (slot: string, text: string) => string };
    const inner = Math.max(1, width - 2);
    const border = (text: string) => {
      try {
        return theme.fg ? theme.fg("border", text) : text;
      } catch {
        return text;
      }
    };
    const out: string[] = [border(`╭${"─".repeat(inner)}╮`)];
    for (const line of lines) {
      const padded = `${line}${" ".repeat(Math.max(0, inner - visibleLength(line)))}`;
      out.push(`${border("│")}${truncateToWidth(padded, inner, "…", false)}${border("│")}`);
    }
    out.push(border(`╰${"─".repeat(inner)}╯`));
    return out;
  }
}

/** Visible width, ignoring the colour codes the theme may have added. */
export function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, "").length;
}

/** Open the panel as an overlay. Shared by the shortcut and the command. */
export async function openWorkflowPanel(
  ctx: ExtensionCommandContext | any,
  manager: WorkflowJobManager,
  theme: Theme,
  options: { width?: number } = {},
): Promise<void> {
  const width = options.width ?? PANEL_WIDTH;
  await (ctx.ui.custom as any)(
    (tui: any, panelTheme: Theme, _kb: any, done: () => void) =>
      new WorkflowPanel({
        manager,
        theme: panelTheme ?? theme,
        done,
        requestRender: () => tui.requestRender?.(),
        width,
      }),
    { overlay: true, overlayOptions: { anchor: "center", width, maxHeight: PANEL_HEIGHT } },
  );
}

/** The glyphs and colours this panel uses, for the tests and for docs. */
export const PANEL_GLYPHS = {
  running: RUNNING,
  paused: "⏸",
  replay: "↺",
  tick: "✓",
  cross: "✗",
  rail: "┆",
} as const;
