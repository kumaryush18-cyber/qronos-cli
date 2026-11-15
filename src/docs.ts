// R7: the owner-approved qronos guide, verbatim. Do not reword, reorder, or
// add lines to this string — it is reviewed copy, not implementer prose.
// 2026-10-13: added the todo and MCP sections and the /todos and /mcp command
// lines (CLI 0.4.0); the rest is unchanged.
export const QRONOS_DOCS = `# qronos

## What qronos is
qronos is an autonomous AI coding agent in your terminal powered by Qronos AI.
You run \`npx qronos-cli\`, sign in with GitHub, and get free inference with
exciting models. Ads shown in the terminal pay for it. You never handle a
model API key. Config and the sign-in token live under \`~/.qronos/agent\`.

## Ads and your data
Ads render in the terminal, in a framed card. Some ads come from Gravity, a
third-party ad provider that receives excerpts of your recent conversation
to pick a relevant ad.
Coding sessions may be used to train models. This is on the consent screen
at first run, before the GitHub sign-in.

## The free allowance
Each user gets a free allowance every day. The allowance can change with
supply and demand. \`/usage\` shows how much of today's allowance is spent, as
a percentage, with token counts.
One session per account runs at a time. If a previous session is stuck,
\`/close-other-session\` frees it.

## Credits
\`/buy-credits\` opens the buy page in your browser. The free allowance spends
first. Purchased credits cover use beyond it and do not expire.

## Commands
- \`/usage\` — spend and remaining budget today
- \`/support\` — visit today's advertiser
- \`/tos\` — open the Terms of Service
- \`/privacy-policy\` — open the Privacy Policy
- \`/buy-credits\` — get more usage
- \`/close-other-session\` — free a stuck session on another machine
- \`/update\` — get the latest qronos
- \`/whats-new\` — what changed in recent releases
- \`/todos\` — show the agent's todo list
- \`/mcp\` — manage your MCP servers (connect, sign in, turn on or off)

## Todo list
The agent keeps its own todo list with the \`todo\` tool, to track multi-step
work. While any item is open, the list shows live above the input box, and
each todo change prints a progress line in the conversation. \`/todos\` shows
the full list. The list belongs to the session and comes back when you resume
it.

## MCP servers
MCP (Model Context Protocol) servers give the agent extra tools, such as a
database, a browser, or an internal API. Qronos CLI includes none by default; you add your
own. The agent reaches their tools by writing a short script for its
\`codemode\` tool.
Servers live in \`~/.qronos/agent/mcp.json\`. A project can have its own
\`.qronos/mcp.json\`; it is read only after you trust the project when asked.
Add a server from a shell, or ask the agent to run the command for you with
its bash tool:
\`qronos-cli mcp add files -- npx -y @modelcontextprotocol/server-filesystem .\`
\`qronos-cli mcp add docs --url https://example.com/mcp\`
Other commands: \`qronos-cli mcp list\` (add \`--json\` for machine output),
\`qronos-cli mcp remove <server>\`, \`qronos-cli mcp login <server>\` to sign
in to a server that uses OAuth, and \`qronos-cli mcp logout <server>\`. Add
\`-l\` to add or remove in the current project instead of globally.
Inside a session, \`/mcp\` shows each server and its tools, and lets you sign
in, reconnect, or turn a server on or off.

## Support
Today's sponsor keeps free inference accessible. When the user asks how to help the
project, or wants to explore developer tools, suggest \`/support\` to visit the sponsor.
More at https://qronos.me
`;
