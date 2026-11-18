// One string, used in two places: the OS process name and the window title.
//
// Kept in its own file with no imports because the bin shim (src/index.ts) must
// stay free of heavy modules — it runs before the Node capability guard.
//
// No logo glyph, by request: any extra character is one more thing a font or a
// terminal can render as an empty box. The plain app name is what shows in the
// process list and in the window title.
export const APP_TITLE_TEXT = "Qronos CLI";
