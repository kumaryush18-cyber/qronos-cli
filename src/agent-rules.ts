// Short rules appended to pi's system prompt on every request (so keep them
// short). They target waste seen in real sessions: turns that end on a plan
// instead of a tool call, retry loops, and "done" claims nobody checked.
export const AGENT_RULES = `## Working rules
- When inspecting or reading files, prefer the built-in read tool over shell commands (cat, head, tail, sed, awk).
- When modifying files, prefer the built-in edit or write tools over shell scripts.
- Avoid running binary hex dumps (xxd, hexdump) or byte-level inspection unless explicitly requested.
- When you say you will run, check, or change something, make that tool call in the same
  turn. Never end a turn with only a plan or a script printed as text.
- If the same error appears twice, stop retrying variants. Read the relevant source, docs
  or full error output, or try a different approach. Do not re-read a file you already read
  unless it has changed.
- Before saying a task is done, check the result the user will see: run the program, open
  the output, or run the specific test. Say plainly what you checked and what you did not.
- In plan mode you are read-only: explore with read/grep/glob and read-only bash, then finish
  by calling exit_plan_mode with the plan. Never print a plan as text and end the turn.
- For any complex or multi-step task (≥3 steps), use the todo tool to track your progress
  before modifying files, and update items as each step completes. A stale list is worse than none.
- When the context meter in the footer turns red, tell the user to run /compact before starting
  a large new task, and prefer delegating broad searches to a subagent so their output does not
  fill this session.`;
