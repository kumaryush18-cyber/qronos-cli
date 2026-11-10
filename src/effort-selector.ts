import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

export interface EffortSelectorOptions {
  currentLevel: string;
  availableLevels: string[];
  defaultLevel?: string;
  ultracodeEnabled?: boolean;
  onSelect: (level: string, persist: boolean) => void;
  onCancel: () => void;
  onToggleUltracode?: (enabled: boolean) => void;
}

const LEVEL_DESCRIPTIONS: Record<string, { summary: string; detail: string }> = {
  off: {
    summary: "No reasoning",
    detail: "Standard token speed. Disables extended thinking for direct responses.",
  },
  minimal: {
    summary: "Minimal reasoning (~1k tokens)",
    detail: "Very brief reasoning. Fast responses with minimal token usage.",
  },
  low: {
    summary: "Light reasoning (~2k tokens)",
    detail: "Fastest responses with minimal reasoning overhead. Ideal for simple queries.",
  },
  medium: {
    summary: "Moderate reasoning (~8k tokens)",
    detail: "Balanced thinking for everyday coding, refactoring, and general problem solving.",
  },
  high: {
    summary: "Deep reasoning (~16k tokens)",
    detail: "Thorough multi-step planning and deep codebase analysis for complex features.",
  },
  xhigh: {
    summary: "Extra-high reasoning (~32k tokens)",
    detail: "May use excessive tokens resulting in long response times or overthinking. Use sparingly for the hardest tasks.",
  },
  max: {
    summary: "Maximum reasoning",
    detail: "Maximum reasoning token budget. Exhaustive step-by-step verification.",
  },
};

const STANDARD_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];

/**
 * Claude Code style horizontal effort slider component.
 * Renders Faster <───▲───> Smarter track with pointer, levels, and keybindings.
 * Fully responsive and guaranteed never to exceed terminal width.
 */
export class ClaudeEffortSelectorComponent {
  private levels: string[];
  private selectedIdx: number;
  private ultracodeOn: boolean;
  private onSelect: (level: string, persist: boolean) => void;
  private onCancel: () => void;
  private onToggleUltracode?: (enabled: boolean) => void;
  public focused = true;

  constructor(opts: EffortSelectorOptions) {
    // If availableLevels has only 1 element (e.g. ['off']), expand to standard 6-level scale
    let filtered = opts.availableLevels.filter((lvl) => lvl !== "minimal" || lvl === opts.currentLevel);
    if (filtered.length <= 1) {
      filtered = [...STANDARD_LEVELS];
    }
    this.levels = filtered;

    const curIdx = this.levels.indexOf(opts.currentLevel);
    this.selectedIdx = curIdx >= 0 ? curIdx : 0;
    this.ultracodeOn = opts.ultracodeEnabled ?? true;
    this.onSelect = opts.onSelect;
    this.onCancel = opts.onCancel;
    this.onToggleUltracode = opts.onToggleUltracode;
  }

  handleInput(keyData: string): void {
    // Left navigation: left arrow, h, down arrow, j
    if (
      matchesKey(keyData, "left") ||
      matchesKey(keyData, "down") ||
      keyData === "h" ||
      keyData === "H" ||
      keyData === "j" ||
      keyData === "J"
    ) {
      if (this.selectedIdx > 0) {
        this.selectedIdx--;
      }
      return;
    }

    // Right navigation: right arrow, l, up arrow, k
    if (
      matchesKey(keyData, "right") ||
      matchesKey(keyData, "up") ||
      keyData === "l" ||
      keyData === "L" ||
      keyData === "k" ||
      keyData === "K"
    ) {
      if (this.selectedIdx < this.levels.length - 1) {
        this.selectedIdx++;
      }
      return;
    }

    // Tab toggles feature
    if (matchesKey(keyData, "tab") || keyData === "\t") {
      this.ultracodeOn = !this.ultracodeOn;
      this.onToggleUltracode?.(this.ultracodeOn);
      return;
    }

    // Enter confirms and saves as default
    if (matchesKey(keyData, "enter") || keyData === "\r" || keyData === "\n") {
      this.onSelect(this.levels[this.selectedIdx], true);
      return;
    }

    // 's' confirms for current session only
    if (keyData === "s" || keyData === "S") {
      this.onSelect(this.levels[this.selectedIdx], false);
      return;
    }

    // Escape or Ctrl+C cancels
    if (matchesKey(keyData, "escape") || matchesKey(keyData, "ctrl+c") || keyData === "\u001b") {
      this.onCancel();
      return;
    }
  }

  render(width: number): string[] {
    const isNarrow = width < 70;
    const isVeryNarrow = width < 52;
    const RESET = "\x1b[0m";
    const BOLD = "\x1b[1m";
    const DIM = "\x1b[2m";
    const CORAL = "\x1b[38;2;255;123;114m";
    const PURPLE = "\x1b[38;2;210;168;255m";

    const lines: string[] = [];
    lines.push(`${BOLD}Effort${RESET}`);
    lines.push("");

    // Label names: shorten "medium" to "med" if terminal width is narrow
    const displayLabels = this.levels.map((l) => (isNarrow && l === "medium" ? "med" : l));

    const trackLeftPad = isNarrow ? 2 : 6;
    const trackRightPad = isNarrow ? 2 : 18;
    const usableWidth = Math.max(20, width - trackLeftPad - trackRightPad);

    const step = usableWidth / Math.max(1, displayLabels.length - 1);
    const colCenters = displayLabels.map((_, i) => Math.round(trackLeftPad + i * step));

    // Faster ... Smarter guide line
    const fasterCol = colCenters[0] ?? trackLeftPad;
    const smarterCol = colCenters[colCenters.length - 1] ?? usableWidth;
    const guideSpaces = Math.max(4, smarterCol - fasterCol - 12);
    const guideLine = " ".repeat(fasterCol) + `${DIM}Faster${" ".repeat(guideSpaces)}Smarter${RESET}`;
    lines.push(guideLine);

    // Track line with active pointer ▲
    const activeCol = colCenters[this.selectedIdx] ?? trackLeftPad;
    let trackChars: string[] = [];
    for (let c = trackLeftPad; c <= smarterCol; c++) {
      if (c === activeCol) {
        trackChars.push(`${BOLD}${CORAL}▲${RESET}`);
      } else {
        trackChars.push(`${DIM}─${RESET}`);
      }
    }
    let trackLine = " ".repeat(trackLeftPad) + trackChars.join("");
    if (!isNarrow) {
      trackLine += `    ${PURPLE}Ultracode  ${this.ultracodeOn ? "on" : "off"}${RESET}`;
    }
    lines.push(trackLine);

    // Labels line
    let labelLine = "";
    let lastCol = 0;
    for (let i = 0; i < displayLabels.length; i++) {
      const raw = displayLabels[i];
      const center = colCenters[i];
      const start = Math.max(lastCol, center - Math.floor(raw.length / 2));
      const pad = Math.max(0, start - lastCol);
      const styled = i === this.selectedIdx ? `${BOLD}${CORAL}${raw}${RESET}` : `${DIM}${raw}${RESET}`;
      labelLine += " ".repeat(pad) + styled;
      lastCol = start + raw.length;
    }
    if (!isNarrow) {
      labelLine += `  ${DIM}Tab to toggle${RESET}`;
    }
    lines.push(labelLine);

    // Ultracode status line if narrow
    if (isNarrow) {
      lines.push(`  ${PURPLE}Ultracode: ${this.ultracodeOn ? "on" : "off"}${RESET}  ${DIM}(Tab to toggle)${RESET}`);
    } else if (this.ultracodeOn) {
      lines.push(`                  ${PURPLE}Ultracode: dynamic workflows on every task${RESET}`);
    }

    // Dynamic description for selected effort level
    const activeLevel = this.levels[this.selectedIdx] || "low";
    const desc = LEVEL_DESCRIPTIONS[activeLevel] || {
      summary: activeLevel,
      detail: "Reasoning effort level for the active model.",
    };
    lines.push(`  ${DIM}${desc.detail}${RESET}`);
    lines.push("");

    // Responsive footer key hints
    let footer = `  ${DIM}←/→ to adjust  ·  Enter to confirm  ·  s for session only  ·  Esc to cancel${RESET}`;
    if (isNarrow) {
      footer = `  ${DIM}←/→ adjust · Enter confirm · s session · Esc cancel${RESET}`;
    }
    if (isVeryNarrow) {
      footer = `  ${DIM}←/→ adjust · Enter ok · Esc cancel${RESET}`;
    }
    lines.push(footer);

    // Hard invariant: EVERY line must be truncated to terminal width
    return lines.map((l) => truncateToWidth(l, width));
  }
}

/**
 * Replaces mode's thinking selector with the Claude Code effort slider.
 */
export function installEffortHandler(mode: any): void {
  mode.showThinkingSelector = function () {
    return this.showSelector((done: () => void) => {
      const selectLevel = (level: string, persist: boolean) => {
        this.selectThinkingLevel(level, persist);
        done();
      };
      const selector = new ClaudeEffortSelectorComponent({
        currentLevel: this.session.thinkingLevel ?? "off",
        availableLevels: this.session.getAvailableThinkingLevels(),
        defaultLevel: this.settingsManager?.getDefaultThinkingLevel?.() ?? "off",
        onSelect: (level, persist) => selectLevel(level, persist),
        onCancel: () => {
          done();
          this.ui.requestRender();
        },
      });
      return { component: selector, focus: selector };
    });
  };

  // Intercept Shift+Tab (app.thinking.cycle) so it no longer cycles thinking
  mode.cycleThinkingLevel = function () {
    this.showStatus?.("Mode: Edit automatically (Shift+Tab to toggle)");
  };
}
