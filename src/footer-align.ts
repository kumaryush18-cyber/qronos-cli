// 0.4.2: pi appends extension statuses (the credits meter) as one extra footer
// line, left-aligned, and collapses any padding we put in the status text. So we
// wrap the footer's render() on our own InteractiveMode instance and right-align
// that last line. pi assigns `mode.footer` once, in its constructor.
//
// 0.5.0: the execution-mode line is prepended above pi's own footer lines. It is
// a marker, not a status, so it keeps its left alignment; only pi's last line —
// the credits status the user scans — is right-aligned.
import { getExecutionModeStatusLine } from "./execution-modes";

const ANSI = /\x1b\[[0-9;]*m/g;
const SIMPLE = /^[\x20-\x7e\xa0-\xff]*$/;

/** Visible width after stripping SGR color codes. */
function visibleLength(text: string): number {
  return text.replace(ANSI, "").length;
}

export function installFooterRightAlign(mode: object): void {
  const footer = (mode as { footer: { render(w: number): string[] } }).footer;
  const render = footer.render.bind(footer);
  footer.render = (w: number) => {
    const lines = render(w);
    const modeStatusLine = getExecutionModeStatusLine(w);
    const withMode = [modeStatusLine, ...lines];

    // A single-line footer (or none) has no pi status line to align; the mode
    // line is still shown.
    if (withMode.length < 2) return withMode;

    const last = withMode[withMode.length - 1]!;
    const text = last.replace(ANSI, "");
    // Wide glyphs or non-SGR escapes (OSC 8 links) make terminal width
    // unmeasurable here, so leave pi's own line exactly as pi drew it.
    if (!SIMPLE.test(text)) return withMode;
    // Never exceed width: when the line already fills it, pad nothing.
    const pad = Math.max(0, w - visibleLength(last));
    return [...withMode.slice(0, -1), " ".repeat(pad) + last];
  };
}
