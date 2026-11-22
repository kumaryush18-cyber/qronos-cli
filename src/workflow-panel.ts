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
  DETAIL_BLOCKS,
  agentsForPhase,
  moveIndex,
  toPanelJob,
  withAnswers,
  type PanelAgentView,
  type PanelJobView,
  type PanelLine,
  type PanelLineStyle,
  type PanelMode,
} from "./workflow-panel-view";
import { formatTokens } from "./workflow-types";
import { AMBER, DARK_RED, PHASE_BLUE, RUNNING, BRIGHT_GREEN } from "./workflow-glyphs";
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
  /** Write the run's report to disk and return its path, for the `s` key. */
  saveScript?: (jobId: string) => string | undefined;
  /**
   * Run one agent again, for the `r` key in the agent view.
   *
   * Returns the outcome as a value, never a throw: the panel shows a line either
   * way, and a panel that dies on a refusal is worse than no key at all.
   */
  restartAgent?: (jobId: string, agentId: string) => Promise<{ ok: boolean; error?: string; edited?: boolean }>;
  /**
   * Stop one agent, leaving the run alone.
   *
   * Optional for the same reason as the others: a panel opened by an old caller
   * must keep working, and a key that does nothing is better than a crash.
   */
  stopAgent?: (jobId: string, agentId: string) => { ok: boolean; error?: string };
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
  private readonly saveScript?: (jobId: string) => string | undefined;
  private readonly restartAgent?: (jobId: string, agentId: string) => Promise<{ ok: boolean; error?: string; edited?: boolean }>;
  private readonly stopAgent?: (jobId: string, agentId: string) => { ok: boolean; error?: string };
  /** The last thing the panel said, shown in the footer. */
  private notice?: string;

  selectedAgent = 0;
  /** Which phase is under the cursor; the right column follows it. */
  selectedPhase = 0;
  /** Which block of the detail view has the cursor: prompt, activity, outcome. */
  selectedBlock = 0;
  /** Blocks the user opened with `enter`. */
  expanded: { prompt?: boolean; activity?: boolean; outcome?: boolean } = {};
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
    this.saveScript = options.saveScript;
    this.restartAgent = options.restartAgent;
    this.stopAgent = options.stopAgent;
    this.startTicker();
  }

  dispose(): void {
    this.stopTicker();
  }

  invalidate(): void {}

  /** Answer texts, from the recent events the job keeps. */
  private answersFor(job: PanelJobView): Record<string, string> {
    const record = this.manager.get(job.id);
    const out: Record<string, string> = {};
    for (const event of record?.recent ?? []) {
      if (event.type !== "agent_end") continue;
      const text = (event as { text?: string }).text;
      const id = (event as { id?: string }).id;
      if (id && text && text.trim() !== "") out[id] = text;
    }
    return out;
  }

  /** The job under the cursor right now, or the newest live one. */
  job(): PanelJobView | undefined {
    return pickJob(this.manager, this.jobId);
  }

  get live(): boolean {
    return this.manager.active().length > 0;
  }

  render(width: number): string[] {
    const panelWidth = Math.max(30, Math.min(this.width, width));
    const base = this.job();
    const job = base ? withAnswers(base, this.answersFor(base)) : undefined;
    const phase = this.frame * (this.frameMs / 3_000);
    const lines = buildPanelLines({
      jobs: this.manager.list().map((entry) => toPanelJob(entry, this.now())),
      job,
      selectedPhase: this.selectedPhase,
      selectedAgent: this.selectedAgent,
      selectedBlock: this.selectedBlock,
      expanded: this.expanded,
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
      if (matchesKey(data, "up") || matchesKey(data, "down")) {
        // The list on the left is the agents of one phase, so the arrows walk
        // that list; the phases are one `esc` away.
        const delta = matchesKey(data, "up") ? -1 : 1;
        this.selectedAgent = moveIndex(this.selectedAgent, agentsInPhase(job, this.selectedPhase).length, delta);
        this.requestRender();
        return;
      }
      if (matchesKey(data, "tab")) {
        // Tab moves the cursor between Prompt, Activity and Outcome, so `enter`
        // knows which block it is opening.
        this.selectedBlock = (this.selectedBlock + 1) % DETAIL_BLOCKS.length;
        this.requestRender();
        return;
      }
      if (matchesKey(data, "return") || data === " ") {
        const block = DETAIL_BLOCKS[this.selectedBlock];
        if (block) this.expanded = { ...this.expanded, [block]: !this.expanded[block] };
        this.requestRender();
        return;
      }
      if (data === "p" || data === "P") {
        if (!job) return;
        if (job.state === "running") this.manager.pause(job.id);
        else if (job.state === "paused") this.manager.resume(job.id);
        this.startTicker();
        this.requestRender();
        return;
      }
      if (data === "x" || data === "X") {
        if (job && (job.state === "running" || job.state === "paused" || job.state === "queued")) {
          this.manager.cancel(job.id);
        }
        this.requestRender();
        return;
      }
      if (data === "k" || data === "K") {
        // In the agent view `k` is about the agent you are looking at, not the
        // run: `x` is still the whole run. Two sizes of the same decision, each
        // on its own key, so neither can be pressed by accident for the other.
        const chosen = agentsInPhase(job, this.selectedPhase)[this.selectedAgent];
        if (!job || !chosen || !this.stopAgent) return;
        const outcome = this.stopAgent(job.id, chosen.id);
        this.notice = outcome.ok
          ? `stopping ${chosen.label}: the rest of the run keeps going`
          : (outcome.error ?? "nothing to stop");
        this.startTicker();
        this.requestRender();
        return;
      }
      if (data === "s" || data === "S") {
        if (!job || !this.saveScript) return;
        const path = this.saveScript(job.id);
        this.notice = path ? `saved to ${path}` : "nothing to save yet";
        this.requestRender();
        return;
      }
      if (data === "r" || data === "R") {
        // In the agent view `r` means "run this one again", not "replay the run":
        // the screen you are looking at decides which agent it is about.
        const chosen = agentsInPhase(job, this.selectedPhase)[this.selectedAgent];
        if (!job || !chosen || !this.restartAgent) return;
        if (job.state === "running" || job.state === "paused" || job.state === "queued") {
          this.notice = "stop the run first: two agents must not spend at once";
          this.requestRender();
          return;
        }
        this.notice = `running ${chosen.label} again…`;
        this.requestRender();
        void this.restartAgent(job.id, chosen.id).then((outcome) => {
          this.notice = outcome.ok
            ? `${chosen.label} ran again${outcome.edited ? " with the task you edited" : ""}: tokens went up`
            : (outcome.error ?? "it did not run");
          this.requestRender();
        });
        return;
      }
      return;
    }

    if (matchesKey(data, "escape")) {
      this.done();
      return;
    }
    if (matchesKey(data, "tab")) {
      // Tab switches between runs when there is more than one; a run per tab is
      // easier to follow than a list of runs above the panel.
      const jobs = this.manager.list();
      if (jobs.length > 1) {
        const current = Math.max(0, jobs.findIndex((entry) => entry.id === job?.id));
        const next = jobs[(current + 1) % jobs.length];
        if (next) this.jobId = next.id;
        this.selectedPhase = 0;
        this.selectedAgent = 0;
      }
      this.requestRender();
      return;
    }
    if (matchesKey(data, "up") || matchesKey(data, "down")) {
      const delta = matchesKey(data, "up") ? -1 : 1;
      // Arrows walk the phases, like Claude Code: the left column is the map of
      // the run, and the right column shows the phase you are pointing at.
      this.selectedPhase = moveIndex(this.selectedPhase, job?.phases.length ?? 0, delta);
      this.selectedAgent = 0;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "left") || matchesKey(data, "right")) {
      const delta = matchesKey(data, "left") ? -1 : 1;
      this.selectedAgent = moveIndex(this.selectedAgent, agentsInPhase(job, this.selectedPhase).length, delta);
      this.requestRender();
      return;
    }
    if (matchesKey(data, "return")) {
      if (job && job.agents.length > 0) {
        this.mode = "agent";
        // Open on the first block, closed: a long prompt would otherwise push
        // the whole panel off the screen the moment you press enter.
        this.selectedBlock = 0;
        this.expanded = {};
        this.requestRender();
      }
      return;
    }
    if (data === "p" || data === "P" || matchesKey(data, "space")) {
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
    if (data === "s" || data === "S") {
      if (!job || !this.saveScript) return;
      const path = this.saveScript(job.id);
      this.notice = path ? `saved to ${path}` : "nothing to save yet";
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
    // A thing the panel just did (saved, or could not save) outranks the id line:
    // it answers a key the user pressed a moment ago.
    const lines: PanelLine[] = [];
    if (this.notice) lines.push({ text: truncateToWidth(`  ${this.notice}`, width - 2, "…", false), style: "hint" });
    const where = job.journalPath ? "journal on disk" : "no journal";
    const resumed = job.resumedFrom ? ` · replayed from ${job.resumedFrom}` : "";
    lines.push({ text: truncateToWidth(`  ${job.id} · ${where}${resumed}`, width - 2, "…", false), style: "hint" });
    return lines;
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
      case "phase-selected":
      case "column-head":
        return ansi(PHASE_BLUE);
      case "description":
        return paint("muted", text);
      case "agent-queued":
        return paint("muted", text);
      case "phase":
        return ansi(PHASE_BLUE);
      case "phase-failed":
      case "agent-bad":
        return ansi(DARK_RED);
      case "agent-ok":
        return ansi(BRIGHT_GREEN);
      case "agent-replay":
        return ansi(PHASE_BLUE);
      case "agent-stopped":
        return ansi(AMBER);
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
  options: {
    width?: number;
    saveScript?: (jobId: string) => string | undefined;
    restartAgent?: (jobId: string, agentId: string) => Promise<{ ok: boolean; error?: string; edited?: boolean }>;
    stopAgent?: (jobId: string, agentId: string) => { ok: boolean; error?: string };
  } = {},
): Promise<boolean> {
  const width = options.width ?? PANEL_WIDTH;
  // A host without overlays (a script, a test, a plain terminal UI) cannot show
  // a floating panel. Saying so is better than throwing at the user.
  if (typeof ctx?.ui?.custom !== "function") return false;
  await (ctx.ui.custom as any)(
    (tui: any, panelTheme: Theme, _kb: any, done: () => void) =>
      new WorkflowPanel({
        manager,
        theme: panelTheme ?? theme,
        done,
        requestRender: () => tui.requestRender?.(),
        width,
        saveScript: options.saveScript,
        restartAgent: options.restartAgent,
        stopAgent: options.stopAgent,
      }),
    { overlay: true, overlayOptions: { anchor: "center", width, maxHeight: PANEL_HEIGHT } },
  );
  return true;
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

/** Agents of a phase, in the order the right column shows them. */
function agentsInPhase(job: PanelJobView | undefined, phaseIndex = 0): PanelAgentView[] {
  if (!job) return [];
  const phase = job.phases[Math.min(Math.max(0, phaseIndex), Math.max(0, job.phases.length - 1))];
  // The same ordering the column is drawn with, so the cursor points at the row
  // you see. Building the list here instead would be a second, silent sort.
  return agentsForPhase(job, phase?.name);
}
