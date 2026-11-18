// Every ad widget write goes through here.
//
// Why this exists: pi's ExtensionContext is invalidated when a session is
// replaced or reloaded, and every later use throws
// "This extension ctx is stale after session replacement or reload."
// (core/extensions/runner.js, assertActive). Ad rendering is deliberately
// fire-and-forget — an un-awaited `void renderBanner(ctx)` from turn_end, a
// 10-minute refresh interval, and a `setWidget` after an awaited /ads/next — so
// a session that is torn down mid-fetch leaves an in-flight write holding a
// stale ctx. That throw used to escape into the agent loop and fail the turn
// (reproduced by Fusion's session-replacement test: "a planner capacity failure
// is retried by pi on the executor").
//
// Ads are decoration. A widget that cannot be drawn because the session it
// belonged to is gone should be dropped silently, never propagated.
import type { ExtensionContext, ExtensionWidgetOptions, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";

/**
 * Both of ctx.ui.setWidget's overloads: pre-rendered lines, or a component
 * factory pi re-renders at the live width. Spelled out because Parameters<>
 * of an overloaded method resolves to the last overload only.
 */
export type WidgetContent =
  | string[]
  | ((tui: TUI, theme: Theme) => Component & { dispose?(): void })
  | undefined;

/**
 * ctx.ui.setWidget, but never fatal. Returns false when the write was dropped
 * because the ctx no longer belongs to a live session.
 */
export function setWidgetSafely(
  ctx: ExtensionContext,
  key: string,
  content: WidgetContent,
  options?: ExtensionWidgetOptions,
): boolean {
  try {
    // The union cannot match a single overload, so narrow explicitly.
    const ui = ctx.ui as unknown as {
      setWidget(key: string, content: WidgetContent, options?: ExtensionWidgetOptions): void;
    };
    ui.setWidget(key, content, options);
    return true;
  } catch {
    // Stale/replaced session, or a UI that is shutting down. Nothing to draw
    // into; the next session_start re-renders from scratch.
    return false;
  }
}

/** ctx.ui.setStatus, but never fatal. Same stale-ctx reasoning as setWidgetSafely. */
export function setStatusSafely(ctx: ExtensionContext, key: string, text: string | undefined): boolean {
  try {
    ctx.ui.setStatus(key, text);
    return true;
  } catch {
    return false;
  }
}
