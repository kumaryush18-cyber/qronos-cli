// 0.4.2: pi appends extension statuses (the credits meter) as one extra footer
// line, left-aligned, and collapses any padding we put in the status text. So we
// wrap the footer's render() on our own InteractiveMode instance and right-align
// that last line. pi assigns `mode.footer` once, in its constructor.
import { getExecutionModeStatusLine } from "./execution-modes";

const ANSI = /\x1b\[[0-9;]*m/g;
const SIMPLE = /^[\x20-\x7e\xa0-\xff]*$/;

export function installFooterRightAlign(mode: object): void {
  const footer = (mode as { footer: { render(w: number): string[] } }).footer;
  const render = footer.render.bind(footer);
  footer.render = (w: number) => {
    const lines = render(w);
    const modeStatusLine = getExecutionModeStatusLine(w);
    const updated = [modeStatusLine, ...lines];
    if (updated.length <= 2) return updated;
    const last = updated[updated.length - 1]!;
    const text = last.replace(ANSI, "");
    if (!SIMPLE.test(text)) return updated;
    // Never exceed width: when the line already fills it, pad nothing.
    return [...updated.slice(0, -1), " ".repeat(Math.max(0, w - text.length)) + last];
  };
}
