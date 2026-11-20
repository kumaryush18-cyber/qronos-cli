// Frame-rate control, ported in spirit from oh-my-pi's frame rate setting.
//
// pi-tui redraws at most once every `TuiBase.MIN_RENDER_INTERVAL_MS` (16 ms,
// i.e. ~60 fps). On battery, over SSH, or inside a slow terminal that constant
// redraw is the difference between a smooth session and a hot laptop. This
// module caps the redraw rate when the user asks for it:
//
//   QRONOS_FPS=30    cap redraws at 30 fps
//   QRONOS_FPS=60    the engine default (16 ms)
//   QRONOS_FPS=0/off keep the engine default and touch nothing
//
// Nothing changes by default: typing latency is the one thing we never trade
// away without being asked.
import { TuiAltScreen } from "@earendil-works/pi-tui";

export const ENGINE_FRAME_INTERVAL_MS = 16;
export const MIN_FPS = 5;
export const MAX_FPS = 60;

/** Parse QRONOS_FPS. Returns undefined when the user did not ask for a cap. */
export function resolveMaxFps(env: Record<string, string | undefined> = {}): number | undefined {
  const raw = (env.QRONOS_FPS ?? "").trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off" || raw === "false" || raw === "default") return undefined;
  const value = Number.parseFloat(raw);
  if (!Number.isFinite(value)) return undefined;
  if (value < MIN_FPS) return MIN_FPS;
  if (value > MAX_FPS) return MAX_FPS;
  return Math.round(value);
}

/** Milliseconds between frames for a given fps, never faster than the engine. */
export function frameIntervalMs(fps: number): number {
  const clamped = Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(fps)));
  // floor, so 60 fps lands exactly on the engine's 16 ms and is a no-op
  return Math.max(ENGINE_FRAME_INTERVAL_MS, Math.floor(1000 / clamped));
}

/** Minimal shape of the class we patch, so tests do not need pi-tui. */
export interface FrameRateTarget {
  MIN_RENDER_INTERVAL_MS?: number;
}

/**
 * Write the interval onto the renderer's base class. Returns the effective
 * interval, or undefined when nothing was changed.
 */
export function applyFrameInterval(target: FrameRateTarget | undefined, fps: number | undefined): number | undefined {
  if (!target || fps === undefined) return undefined;
  const interval = frameIntervalMs(fps);
  if (interval <= ENGINE_FRAME_INTERVAL_MS) return undefined; // nothing to cap
  try {
    target.MIN_RENDER_INTERVAL_MS = interval;
    return interval;
  } catch {
    return undefined;
  }
}

/**
 * The renderer's frame interval lives on the shared base class of the two
 * screen implementations, not on the instance, so one write covers both.
 */
export function frameRateTargetFrom(screen?: unknown): FrameRateTarget | undefined {
  const screenClass = (screen ?? TuiAltScreen) as { constructor?: { prototype?: unknown } } | undefined;
  const base = screenClass ? Object.getPrototypeOf(screenClass) : undefined;
  return (base ?? screenClass) as FrameRateTarget | undefined;
}

/** Startup entry point, mirroring ensureUiDefaults(): safe to call twice. */
export function installFrameRateCap(env: Record<string, string | undefined> = {}): number | undefined {
  return applyFrameInterval(frameRateTargetFrom(), resolveMaxFps(env));
}
