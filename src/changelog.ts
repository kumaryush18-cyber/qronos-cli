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
    version: "1.0.22",
    highlights: [
      "A saved script can run again. /workflows scripts lists what is in .qronos/workflows, /workflows run <name> starts one, and /workflows edit <name> opens it in your editor. Saving without a way back is a drawer that only opens one way.",
      "run never pretends to start the run by itself: a command cannot run tools, so it asks the chat's own agent to call the workflow tool with scriptFile, and the tool reads the exact text from disk. Nothing is retyped, so the file you edited is the file that runs.",
      "The approval card still comes first, and it names the script and where it came from. A file on disk is not more trustworthy than a script from a chat.",
      "edit asks before it writes: Save the change? with the path, the cursor on No, and no overlay meaning No. An edited project file is never replaced in silence.",
      "Names are forgiving in one narrow way: review, review.js and Review all find the same script. Anything else is no such script, with the list, because guessing which script someone meant is worse than saying no.",
      "The workflow tool gained a scriptFile parameter, so a model can point at a saved script instead of pasting it — one path for a script from the chat and a script from disk.",
      "Proved on claude-haiku-5.5, end to end: a script written where s would write it, listed, run for real (two agents, 3.8k tokens), edited, declined once, then saved (18 checks, scripts/workflow-scripts-e2e.ts).",
    ],
  },
  {
    version: "1.0.21",
    highlights: [
      "The restart card now offers the answer that is usually the right one: edit the task, then run it. Two (or e) opens the words for typing in the card, ctrl+g opens your own $EDITOR on them, enter runs what is there, and esc goes back to the answers without running anything.",
      "The card shows the task that would be repeated, so you are never agreeing to words you cannot see. A changed task is labelled edited, not the task it had before, and a long one is cut with a count of the hidden lines instead of a silent truncation.",
      "An edited task becomes the task that was kept, so the Prompt block never shows words that were not really sent. The detail view then reads Prompt · edited and attempt 2 · ran again 1 time, so a second try can never look like the first.",
      "Each attempt is written down: when it ran, whether it worked, what it cost, and the task when you changed it. Five are kept — enough to see the story, small enough that a record is still a record.",
      "The safe default is unchanged: the cursor starts on No, closing the card means No, and identical words are not sent as a new task, so an accidental enter costs nothing.",
      "One editor helper serves both cards now ($EDITOR on a temp file we made, removed whatever happens), so the script card and the task card cannot behave differently when the editor is missing, fails, or changes nothing.",
      "Proved on claude-haiku-5.5: the card is refused once and nothing is spent, then the task is edited and a second attempt really costs money (scripts/workflow-restart-e2e.ts).",
    ],
  },
  {
    version: "1.0.20",
    highlights: [
      "One agent missed the point and the other eleven were fine. Now you can run that one again: enter opens it, r runs it, and nothing else in the run changes.",
      "It costs tokens, so it asks first — and the cursor starts on No: this calls the model again and spends tokens again, the rest of the run is not touched. Closing the card means No, so silence never spends anything.",
      "The bill stays honest. tokens goes up by what the second attempt cost and replayedTokens does not move, because a restart is new work and not a replay. The row says ✓ Done · restarted, so a report can never pass the second charge off as free.",
      "A live run is refused with a line that says why: stop the run first, so two agents cannot spend on the same job at once. The same agent cannot be started twice at once either — one keypress is one call.",
      "The agent detail header now carries the context size beside the model name: claude-haiku-5.5 [1m]. It answers the question you actually have about a stuck agent: did it have room to read the whole file? An unknown size shows the name alone, never a guessed number.",
      "The old tool rows are dropped on a restart, because they belong to the old attempt, and showing them beside a new answer would invite the wrong conclusion.",
      "Proved against claude-haiku-5.5: a real two-agent run, one agent restarted with a real card, its tokens went up, the other agent was byte-for-byte untouched (checks in scripts/workflow-restart-e2e.ts).",
    ],
  },
  {
    version: "1.0.19",
    highlights: [
      "A workflow subagent can no longer use a tool in silence. Every call a subagent makes now meets the chat's own permission mode, read at the moment the tool would run — not when the run started.",
      "The card lands in the chat, not in the panel, because a decision belongs where the conversation is. The panel still only reads. The heading glows the same pale orange as the header and names the run: Bash command · from the \"analyze-src\" workflow, 1 of 3.",
      "Four answers, as in Claude Code: Yes · Yes, allow shell commands for this run · Yes, and switch to auto mode · No. The second one is a grant for one run only, and it is never written to a file.",
      "Closing the card with esc means No. The grant dies with the run, so a resumed run asks again. A refused tool is not a crash: the subagent receives No: <reason> as the tool result, says what it wanted to do, and the rest of the run carries on.",
      "The default mode still lets normal work run: in auto, a read, a write inside the project and a plain shell command go ahead, and only a command that can destroy work or a write outside the project stops to ask.",
      "A headless run has no one to ask, so a call the mode would question is refused instead of allowed. Silence never becomes a yes. QRONOS_WORKFLOW_TOOLS=0 turns the door off and restores the old behaviour.",
      "The decision is one pure function in its own file, so the mode table is tested without a terminal: 39 tests on the table, 23 on the card, 11 on the gate inside a real run.",
      "A workflow agent now holds the same tools as the chat instead of a read-only list, so bash and write can finally be offered to it. The door is what decides whether a call runs, so a door nobody could reach would have guarded nothing.",
      "Proved on claude-haiku-5.5, end to end: the card really appeared for a real bash call, esc meant No and the command never ran, then answer 1 meant Yes and the command printed the file (12 checks, scripts/workflow-tool-approval-e2e.ts).",
    ],
  },
  {
    version: "1.0.18",
    highlights: [
      "A background workflow now has a row of its own above the editor: ※ Waiting for 1 dynamic workflow to finish. Before this the CLI looked idle while five agents worked and the token bill went up.",
      "The row is alive: the ※ breathes and the same 3 s pale-orange band flows through the words as through the header and the working line. One moving light means one thing everywhere: this is happening now.",
      "It sits below the working line, so both can be true at once: the assistant is answering and a workflow is still running. The ticker stops when the last run ends — one final empty frame, then nothing.",
      "The count comes from the job manager itself, not from the places that start and stop runs. One hook, so a run cancelled from the panel cannot leave the row behind. The row only knows a number: it cannot start, stop or read a run.",
      "Closing the panel now leaves one muted line in the chat: └ Dynamic workflows dialog dismissed. It is a custom entry, not a message, so it is drawn for you and never sent to the model.",
      "A finished run ends with a table of the structured results when at least two agents returned schema-checked data: # then the keys they agreed on. A key only one agent used is still a column, with a gap, because a gap is information.",
      "Table cells are one line and cut at 28 characters with a visible …, so a long description cannot push the last column off the screen. A run with no structured data gets no table at all.",
      "Proved on claude-haiku-5.5 with a real schema fan-out: the waiting row appeared and went away, the dismissal line was appended, and the report ended with a table of what the agents really returned (54 checks).",
    ],
  },
  {
    version: "1.0.17",
    highlights: [
      "enter in the workflow panel now opens one agent properly: a list of the agents on the left, and that agent's whole story on the right, in the same shape Claude Code uses.",
      "Three blocks, each with a cursor you can reach: Prompt (what the agent was asked), Activity (the last tool calls) and Outcome (Still running…, the error, or the answer). tab moves between them, enter opens or closes one.",
      "A tool row now carries the first line of its arguments, so it reads read(path: package.json) and not just read. The arguments are redacted first and cut at 80 characters after, so a cut can never leave half a secret behind.",
      "The facts line answers the question you actually have when an agent looks stuck: 0 tokens · 6 tools · idle 1m 01s. Idle counts from the last tool call, and the newest call of a working agent is marked · now.",
      "Blocks are closed when you arrive, because a 7-line task would otherwise push the keys off the screen the moment you press enter. … 5 more lines says how much is folded away.",
      "The arrows walk the agents of the phase inside this screen, and esc goes back to the phases. p, x and r keep working: it is the same run, and a screen that hides the controls of the run you are watching is a dead end.",
      "Queued agents are left out of this list: an arrow key that lands on waiting and shows an empty screen is a trap.",
      "Proved on claude-haiku-5.5 with a real agent: the detail view opened, the prompt and the activity expanded, the tool row named the tool and its argument, and the outcome arrived (41 checks).",
    ],
  },
  {
    version: "1.0.16",
    highlights: [
      "A script can now name the phase of one agent: agent(prompt, { label, phase: 'Analyze', schema }). phase() still names everything after it, which is right for a straight script; a parallel map needs a name per item, and this is it.",
      "The phase is resolved when the agent starts, not when it ends. Before this, an agent that was still working while the script moved on to the next phase was filed under the new one, so the panel could show a row in the wrong column.",
      "A phase named only by an agent still exists: the report lists it and the panel draws its column. A blank or whitespace name means the current phase, never a phase called nothing.",
      "The script notice now shows the shape a real fan-out uses: an array of areas, phase() once before the group, then parallel(AREAS.map((a) => agent(a.prompt, { label: a.key, phase }))). It also says plainly that a failed agent is { ok: false } and never null, so check r.ok.",
      "Proved on claude-haiku-5.5 with a real two-agent map: both agents landed in the named phase and the run listed it (38 checks).",
    ],
  },
  {
    version: "1.0.15",
    highlights: [
      "Groundwork for a real agent detail view: a workflow now remembers the task each agent was given and every tool call it made, so the panel can say 6 tool calls · last 3: Bash, read, grep while the agent is still working.",
      "The count of tool calls always rises; only the kept rows stop at eight. The last tool calls are the ones a person reads, and the number still says 3 of 41 honestly.",
      "The task text is redacted and capped at 1 200 characters before it is kept, so a prompt that carried a key cannot be shown back later.",
      "Agents that are still working now live in a map of their own instead of being guessed from the last sixty events. Sixteen agents making forty tool calls each used to push every start out of that window, and the panel went blank while the run was busiest.",
      "Activity is display-only, so it is not written to the journal: a journal that grows with every tool call is slow to read and expensive to keep. A resumed run still shows the task, and the tool count arrives with the agent's record.",
      "Proved on claude-haiku-5.5 with a real agent and real tools: the task was kept, one tool call was counted, and the kept activity named the tool that ran (35 checks).",
    ],
  },
  {
    version: "1.0.14",
    highlights: [
      "The workflow panel is now two columns, like Claude Code's: the phases on the left, the agents of the phase you are pointing at on the right. One long mixed list made you scroll to connect a phase with its work; a column each puts the connection on the same line.",
      "Each agent row carries its model, its tokens and its time, and the header says how many agents have finished out of how many the script planned (2/5, not 5 running), with the description under it.",
      "Agents the plan promised and the script has not started yet get a row too: the mark is ↻ and the side says queued. A panel that is empty while five agents are queued looks broken exactly when you most want to look at it.",
      "New keys: p pauses (space still works), ↑↓ walks the phases, ←→ walks the agents of a phase, tab moves between runs, and s saves the script to <project>/.qronos/workflows/<name>.js so a good run can be used again tomorrow. An existing file is never overwritten: the new one gets -2, -3.",
      "s is also /workflows save <id>, because a floating panel must never be the only way to do something.",
      "The panel's notice line says where the script went, or that nothing could be written. A failed save never takes a run down with it.",
      "Two runs that start in the same millisecond used to be able to swap places in the list. The id breaks the tie now, so a list that descends by time stays still.",
    ],
  },
  {
    version: "1.0.13",
    highlights: [
      "Workflows ask before they spend. A run of three or more written agent calls now shows a card first: the name, the description, the phases with their agent counts and a sample task, an estimate of the cost, and the three answers Claude Code offers — 1. Yes, run it, 2. View raw script, 3. No.",
      "The card is a real card, and its heading glows with the same 3 s pale-orange band as the CLI header. Keys: 1 2 3 to pick, enter to confirm, tab to amend the description, ctrl+g to open the script in $VISUAL/$EDITOR and re-read it on save, esc to cancel.",
      "Saying No costs nothing: nothing launches, nothing is written to the journal, and the tool reports that the run was not started, so the model cannot pretend otherwise. A resume is never asked about twice.",
      "No terminal means no question. In a test, a script or an E2E run the card is skipped and the run goes ahead. A guard that blocks headless use would be worse than no guard.",
      "Scripts can declare their own plan now: export const meta = { name, description, phases: [{ title, agents, prompt }] }. It is read with a brace scan and a JSON parse, never by running the code, so a preview cannot execute anything.",
      "Caps raised to Claude Code's numbers: 16 agents at once instead of 8, and 1000 agents per run instead of 60 (the environment variable still clamps to 2000).",
      "QRONOS_WORKFLOW_APPROVE decides when the card appears: unset/ask (the default), always, or 0/off.",
      "Proved on claude-haiku-5.5: the card read a real script's plan, a No stopped it with ok:false and nothing on disk, a Yes launched the run and the report arrived, and the whole workflow E2E still passes (30 checks).",
    ],
  },
  {
    version: "1.0.12",
    highlights: [
      "Workflows have a live panel now: Alt+W, or /workflows panel, opens a floating view in the middle of the screen, the same shape as the Agent Hub. Header with running, done, tokens and time; one bar per phase; one row per agent; the footer says which run you are looking at and whether its journal is on disk.",
      "The panel uses the same 3 s pale-orange shimmer as the header for whatever is working right now: the active phase and the running agents. One moving light now means one thing everywhere in the CLI.",
      "Keys: space pauses or resumes, x stops, enter opens one agent (phase, cost, time, error, answer), arrows move between runs or agents, r replays a finished run from its journal, esc goes back or closes. Every one of them is also a /workflows command, so the panel is never the only way to do something.",
      "Agents that are still working now get their own row with their own name and a time that counts up. Before this, a run with nothing finished yet drew no rows at all, which looked broken exactly when you wanted to look at it.",
      "The ticker is honest: 120 ms redraws only while a run is live, one last frame when the last run ends, then nothing. A panel left open on a finished run costs no terminal work.",
      "Proved on a real model (claude-haiku-5.5): Alt+W opened the overlay on a live 3-agent run, every line was the same width, space paused it and space let it run again, and the panel drew the finish without a single silent cap.",
    ],
  },
  {
    version: "1.0.11",
    highlights: [
      "Workflows can be paused and resumed, the way Claude Code does it. /workflows pause stops new agents and lets the ones in flight finish; /workflows resume carries on from the pause and replays nothing. The wall clock pauses with the run, so a run paused overnight keeps its full ten minutes.",
      "A run that is not live any more can be replayed from its journal: /workflows resume <id>, or resumeFrom on the tool. Finished agents whose prompt, agent type and model did not change are answered from the record and cost nothing again; the first changed or failed call, and everything after it, runs live. The report counts both: fresh tokens, and the tokens a replay did not spend again.",
      "The script's own clock is now deterministic: Date.now() and new Date() are frozen at the run's start time and Math.random() is seeded, so a replayed script makes the same decisions. Explicit dates (new Date(0)) still work. Claude Code makes these throw; we keep them usable, which is strictly friendlier and just as exact.",
      "/workflows saved lists the runs on disk, from this session or an earlier one, so a run lost to a closed terminal can be picked up tomorrow.",
      "Visuals: a replayed agent shows a blue ↺ instead of a tick, and the status line shows a pause symbol while a run is paused. A live job is no longer labelled failed in its own detail view.",
      "Proved on a real model (claude-haiku-5.5): pause mid-run then resume in 56s with 0 replayed, and stop-then-replay finishing 3 agents in 22s with 1 replayed where a fresh run took 59s.",
    ],
  },
  {
    version: "1.0.10",
    highlights: [
      "Workflows now run in the background, like Claude Code: the tool returns a job id at once, the run continues while you talk, and the report arrives as a message on a later turn. Pass background: false only when the answer is needed in the same turn.",
      "/workflows is now live: state, running agents, done, tokens and time per job, /workflows <id> for detail, /workflows stop <id> to stop one. The list is per session, so two sessions never see or stop each other's work.",
      "Every run writes a redacted journal to ~/.qronos/agent/workflow-runs/<id>.jsonl: the script, phases, each agent with tokens and time, and the result. A crash damages the last line only, and the record is what a future resume replays.",
      "One slot pool for the whole process: a background workflow and a chat subagent share the same 8 slots, so nothing doubles the load.",
      "A real end to end run (claude-haiku-5.5) proves the new path: launch returns in 2 ms, 4 agents, 8.6k tokens, the report delivered once, the journal on disk, and a cancel that really stops a run.",
    ],
  },
  {
    version: "1.0.9",
    highlights: [
      "Workflows grew teeth: a per-agent model (cheap model for extraction, strong model for judgement), a nested workflow() one level deep that shares the same budget, and args / budget so a script can decide how much work to start.",
      "Token accounting per agent and per phase: /workflows lists every agent sorted by cost with a bar, a bright green tick or a dark red cross, its tokens and its time. A live line shows running, done and tokens while it works.",
      "A real-model end to end run (claude-haiku-5.5) proves it: 4 agents, 8.6k tokens, phases priced, a nested child at depth 2, a routed agent, and the agent cap stopping a runaway script.",
      "Verified against Claude Code's documented behaviour: background launch, resume and the live panel are the remaining steps.",
    ],
  },
  {
    version: "1.0.8",
    highlights: [
      "Write ultracode in a prompt and the task becomes a workflow: the model writes a small JavaScript script that hands the work to many subagents, and only the final result comes back to the chat. Big audits no longer flood the conversation.",
      "The script has five helpers (agent, parallel, pipeline, phase, log) and nothing else: no imports, no filesystem, no network, no process. A run is capped at 10 minutes, 60 agents and 8 at a time, and the cap is always reported.",
      "orchestrate joins ultrathink and ultracode as a magic keyword: it splits a prompt into independent parts and runs them in parallel.",
      "All three keywords glow orange as you type them, with the same flowing band. /workflows shows the last run, phase by phase, with a tick or a cross for every agent.",
      "Windows is now green in CI: no more backslashes in rename warnings, and the tests no longer assume a POSIX shell.",
    ],
  },
  {
    version: "1.0.7",
    highlights: [
      "Learned memory, on by default: every turn is journaled locally, a cheap sync folds what matters into a small document, and the next session gets it as hints. /memory shows, syncs or clears it, and the agent can save a fact with the learn tool.",
      "Type ultrathink in the input box and the word turns orange with a light band flowing through it. It also asks for a careful plan before any edit, for that turn only.",
      "Compaction now prunes the history first, records exact file paths, commands and errors with code instead of letting the model paraphrase them, redacts secrets, and refuses a bad summary so the built-in one runs.",
      "First run as a public repository: CI and the npm publish workflow run on every push.",
    ],
  },
  {
    version: "1.0.6",
    highlights: [
      "New working line: Claude Code style spinner with playful verbs, a new word every 6 seconds, live output tokens and \"Churned for 2m 30s\" when the answer arrives. It sits above the input box, with a light-orange glow every 3 seconds.",
      "The Qronos AI header glows too, and its version is pale orange.",
      "/reverse-engineer-anything now lists what can really run on your machine (JEB, Hopper, pwntools, adb, tshark...), so a missing backend no longer looks like a broken install.",
      "Qronos AI admin live requests now show QRONOS CLI instead of API.",
    ],
  },
  {
    version: "1.0.5",
    highlights: [
      "Click inside the input box to put the cursor there (fullscreen mode is now the default; QRONOS_TUI_MODE=regular goes back).",
      "The working line shows the real context size beside the spinner (⠋ ↓ 12.3k).",
      "Ctrl+C no longer deletes what you typed; Escape interrupts, Ctrl+D exits.",
      "Window title and process name say Qronos CLI instead of node; the @ file list closes the moment you delete the @.",
    ],
  },
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
