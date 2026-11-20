// Notification extension: one desktop notification when a turn ends.
//
// Deliberately one hook and no state. The interesting logic (which terminal,
// which escape sequence, when to stay silent) lives in notifications.ts.
import type { ExtensionAPI, ExtensionContext, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createNotifier, turnEndMessage, type Notifier } from "./notifications";

export const NOTIFY_TITLE = "Qronos CLI";

export interface NotifyOptions {
  /** Injected for tests. */
  notifier?: Notifier;
  /** Seconds between turn start and turn end, for the "after 2 min" wording. */
  now?: () => number;
}

export function createNotifyExtension(options: NotifyOptions = {}): ExtensionFactory | undefined {
  const notify = options.notifier ?? createNotifier();
  const now = options.now ?? (() => Date.now());
  let startedAt = now();

  const extension: ExtensionFactory = (qronos: ExtensionAPI) => {
    qronos.on("turn_start", async () => {
      startedAt = now();
    });

    qronos.on("turn_end", async (event, ctx: ExtensionContext) => {
      const seconds = Math.max(0, Math.round((now() - startedAt) / 1000));
      const aborted = Boolean((event as { aborted?: boolean }).aborted);
      // A one-second turn is already on screen; do not buzz the user for it.
      if (seconds < 5) return;
      const body = turnEndMessage({ aborted, seconds });
      notify(NOTIFY_TITLE, body);
      void ctx;
    });
  };

  return extension;
}
