// 0.2.6: bundled changelog highlights for the what's-new-on-startup banner
// (whats-new.ts). The published package ships only `dist` + README (see
// package.json `files`), so CHANGELOG.md — the canonical human doc — would not
// reach users; this module IS bundled into the build. Keep the newest entry's
// version in sync with package.json (changelog.test.ts asserts it).

export interface ChangelogEntry {
  version: string;
  highlights: string[];
}

export const CHANGELOG_HIGHLIGHTS: ChangelogEntry[] = [
  {
    version: "1.0.4",
    highlights: [
      "Subagent runtime error fallback: automatically falls back and retries with parent session model on model quota or tier failures.",
      "Authenticated subagent execution passing session credentials and client headers.",
      "Error surfacing on subagent completion instead of empty success stubs.",
    ],
  },
  {
    version: "1.0.3",
    highlights: [
      "Real-time contextual ad bidding: passes user prompt context to Gravity live auction.",
      "Reliable autonomous subagents: actively inspect files and code before reporting.",
      "Added /paste-image command to grab screenshots directly from your system clipboard.",
    ],
  },
  {
    version: "1.0.2",
    highlights: [
      "Cross-platform reliability fixes for Windows and macOS environments.",
      "Live DuckDuckGo web search and library documentation lookup.",
      "Enhanced orange styling across the Privacy & Transparency consent screen.",
    ],
  },
  {
    version: "1.0.1",
    highlights: [
      "Vibrant brand styling: bold orange headers, glowing cursor, and clean compact token counters (10M).",
      "Streamlined commands: eliminated duplicate /compact warning.",
      "Optimized footer: real-time 10M token allowance tracking.",
    ],
  },
  {
    version: "1.0.0",
    highlights: [
      "Qronos CLI 1.0: the whole tool now carries one name. Config lives in ~/.qronos, and the help, errors and prompts all say qronos.",
      "First run offers two choices: sign in to the Qronos Gateway, or bring your own API key from any OpenAI-compatible provider.",
      "Plan mode writes an artifact you can read and approve before any file changes.",
    ],
  },
  {
    version: "0.4.10",
    highlights: [
      "Images you generate now show right in your terminal (iTerm2, Kitty, Ghostty, WezTerm, Warp). Other terminals still get the saved file path.",
    ],
  },
  {
    version: "0.4.9",
    highlights: [
      "🧨 Fusion is now much cheaper: DeepSeek V4 Pro plans and DeepSeek V4 Flash builds, so each Fusion turn uses a small fraction of the allowance it used to. Fusion is also listed first in /model.",
    ],
  },
  {
    version: "0.4.8",
    highlights: [
      "The agent can now make images: ask for a mockup, icon or illustration and generate_image saves it into your project's images/ folder. Each image counts toward your daily allowance.",
      "Clearer limit messages: you now see when a limit clears and how many credits you have left today.",
    ],
  },
  {
    version: "0.4.7",
    highlights: [
      "qronos now updates itself when a new version is required: no more running npx qronos-cli@latest.",
      "The ad box redraws at your terminal's width after a resize, and never overflows with wide characters.",
    ],
  },
  {
    version: "0.4.6",
    highlights: [
      "Free web search and documentation lookup: the agent can now search the web (web_search) and look up current library docs (docs_lookup). Both run on the qronos server and count toward your daily allowance.",
    ],
  },
  {
    version: "0.4.5",
    highlights: [
      "New /reverse-engineer-anything command: loads REA reverse-engineering tools (apps, binaries, APKs, websites) into the session. For lawful, authorized analysis only.",
    ],
  },
  {
    version: "0.4.4",
    highlights: [
      "Updated terms: you'll be asked to accept them once.",
      "Some ads now come from Gravity, measured with a small tracker. Turn it off with QRONOS_NO_GRAVITY_PIXEL=1.",
    ],
  },
  {
    version: "0.4.3",
    highlights: [
      "The ad banner now refreshes while you work, at most once a minute.",
      "If our terms have changed since you signed up, you'll be asked to review and accept them.",
    ],
  },
  {
    version: "0.4.2",
    highlights: ["Credits now sit on the right of the footer, under the model name."],
  },
  {
    version: "0.4.1",
    highlights: [
      "The footer now shows your credits left, including any you bought. A warning appears when you are low or in the slow lane.",
      "/usage shows credits left today and when they refill, with /buy-credits to get more.",
    ],
  },
  {
    version: "0.4.0",
    highlights: [
      "The agent now keeps a todo list for multi-step work: it shows live above the input box, and /todos shows the full list.",
      "Add your own MCP servers: `npx qronos-cli mcp add`, then /mcp in a session to manage them.",
    ],
  },
  {
    version: "0.3.0",
    highlights: [
      "Upgraded the underlying pi agent engine to 1.2.0.",
      "/bug now sends reports to the qronos team.",
      "`npx qronos-cli --session <id>` resumes a session again.",
    ],
  },
  {
    version: "0.2.19",
    highlights: [
      "More models to pick from: Solar Pro 4, GLM 5.3 Flash, and a Groq speed lane. /model to switch.",
      "The model picker now shows how far each model stretches your daily allowance.",
      "Update notices and the resume command now name qronos, not pi.",
    ],
  },
  {
    version: "0.2.18",
    highlights: [
      "Clearer wording in the startup consent line.",
    ],
  },
  {
    version: "0.2.17",
    highlights: [
      "/tos and /privacy-policy open the Terms and Privacy Policy in your browser.",
      "The consent screen and startup header now state that usage is funded by ads and training.",
    ],
  },
  {
    version: "0.2.16",
    highlights: [
      "The whole ad card is now one clickable link.",
      "Ask the agent about qronos: it can explain the allowance, credits, and commands.",
    ],
  },
  {
    version: "0.2.15",
    highlights: [
      "New startup screen: the model, a welcome line, and the five qronos commands.",
      "/support opens today's advertiser in your browser. It grants nothing.",
    ],
  },
  {
    version: "0.2.14",
    highlights: [
      "No user-facing changes. This version tests the automated npm publish from GitHub Actions.",
    ],
  },
  {
    version: "0.2.13",
    highlights: [
      "Purchased balance is now shown as credits — $5 buys 50,000 credits, $10 buys 100,000.",
      "The usage summary is cleaner: your free allowance still shows as a percentage, with token counts, and no request tally.",
    ],
  },
  {
    version: "0.2.12",
    highlights: [
      "New: /buy-credits and /usage slash commands — work instantly, even when you are out of usage.",
      "Free usage is shown as a percentage, never a dollar figure; purchased credit stays in dollars.",
      "Clearer messages: one readable line when a request is rejected, a heads-up at 80% of your daily allowance, and a confirmation when a purchase lands.",
    ],
  },
  {
    version: "0.2.11",
    highlights: [
      "Out of free usage? You can now buy more — $5 or $10 packs, card or USDC. Ask qronos to \"buy credits\" or follow the link in the out-of-usage notice.",
      "The out-of-usage notice now comes from the server, and `qronos_usage` shows your purchased balance.",
    ],
  },
  {
    version: "0.2.10",
    highlights: [
      "qronos now installs an exact, tested version of the underlying agent — an upstream release can no longer change your CLI without us testing it first.",
    ],
  },
  {
    version: "0.2.9",
    highlights: [
      "Windows: self-update and browser sign-in actually work now — both had been broken since they shipped.",
      "Running without a terminal (CI, piped input) now says so and exits, instead of hanging or quietly doing nothing.",
      "New: `qronos-cli logout`, `--version` and `--help`.",
    ],
  },
  {
    version: "0.2.8",
    highlights: [
      "You can now pick between models — run /model to see the list and switch (when the server offers more than one).",
    ],
  },
  {
    version: "0.2.7",
    highlights: [
      "The model list now reliably shows just the qronos model — including HuggingFace, AWS, and Vertex — while leaving every credential in your shell untouched.",
    ],
  },
  {
    version: "0.2.6",
    highlights: [
      "New: /close-other-session clears a stuck session so you're never locked out waiting.",
      "New: /whats-new and /update commands.",
      "The model list now shows just the qronos model (add your own keys with /login).",
      "This 'what's new' note, shown once after an update.",
    ],
  },
  {
    version: "0.2.5",
    highlights: [
      "The model you're actually using now shows correctly in the status line.",
      "Free Ox Alpha trial — a frontier preview model, on the house.",
    ],
  },
  {
    version: "0.2.4",
    highlights: ["Fixed a startup crash on older Node versions."],
  },
  {
    version: "0.2.3",
    highlights: ["Friendly 'please upgrade Node' message instead of a crash mid-request."],
  },
];

/** Highlights for a specific version, or undefined if none are recorded. */
export function highlightsFor(version: string): string[] | undefined {
  return CHANGELOG_HIGHLIGHTS.find((e) => e.version === version)?.highlights;
}
