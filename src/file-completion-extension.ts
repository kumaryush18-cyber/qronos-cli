// Registers the `@file` completion fallback (see file-completion.ts for why a
// fallback is needed at all). Registered on session_start, the only point where
// the extension context carries the session cwd.
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";
import { createFileCompletionProvider, type FileCompletionDeps } from "./file-completion";

export interface CreateFileCompletionOptions {
  /** Injected in tests. */
  deps?: FileCompletionDeps;
}

export function createFileCompletionExtension(opts: CreateFileCompletionOptions = {}): InlineExtension {
  return {
    name: "qronos-file-completion",
    factory(qronos: ExtensionAPI) {
      qronos.on("session_start", (_event, ctx) => {
        // Read the cwd lazily rather than capturing it: after /tree, resume or
        // fork the provider is asked for suggestions under a new root, and the
        // context object handed to this handler does not update.
        let cwd = ctx.cwd;
        ctx.ui.addAutocompleteProvider(
          createFileCompletionProvider(opts.deps, () => cwd),
        );
      });
    },
  };
}
