import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/**
 * /init command implementation:
 * Analyzes the current project workspace and generates a tailored `QRONOS.md`
 * memory file in the repository root, matching Claude Code's `claude init`.
 */
export async function runInit(ctx: ExtensionCommandContext): Promise<void> {
  const cwd = ctx.cwd || process.cwd();
  const qronosPath = join(cwd, "QRONOS.md");

  if (existsSync(qronosPath)) {
    const overwrite = await ctx.ui.confirm(
      "QRONOS.md Already Exists",
      "A QRONOS.md file already exists in this directory. Do you want to overwrite it?"
    );
    if (!overwrite) {
      ctx.ui.notify("QRONOS.md setup cancelled.", "info");
      return;
    }
  }

  // 1. Inspect Workspace Stack & Commands
  let projectName = "Project";
  let techStack = "General Software Project";
  const commands: { build?: string; test?: string; lint?: string; dev?: string } = {};

  // Node / JavaScript / TypeScript
  const pkgPath = join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(await readFile(pkgPath, "utf8"));
      projectName = pkg.name || "Node Project";
      techStack = "Node.js / TypeScript / JavaScript";
      if (pkg.scripts) {
        if (pkg.scripts.build) commands.build = "npm run build";
        if (pkg.scripts.test) commands.test = "npm test";
        if (pkg.scripts.lint) commands.lint = "npm run lint";
        if (pkg.scripts.dev) commands.dev = "npm run dev";
      }
    } catch {
      // ignore parse errors
    }
  }

  // Rust
  const cargoPath = join(cwd, "Cargo.toml");
  if (existsSync(cargoPath)) {
    techStack = "Rust";
    commands.build = commands.build || "cargo build";
    commands.test = commands.test || "cargo test";
    commands.lint = commands.lint || "cargo clippy";
  }

  // Python
  const pyprojectPath = join(cwd, "pyproject.toml");
  const requirementsPath = join(cwd, "requirements.txt");
  if (existsSync(pyprojectPath) || existsSync(requirementsPath)) {
    techStack = "Python";
    commands.test = commands.test || "pytest";
    commands.lint = commands.lint || "ruff check .";
  }

  // Go
  const goModPath = join(cwd, "go.mod");
  if (existsSync(goModPath)) {
    techStack = "Go";
    commands.build = commands.build || "go build ./...";
    commands.test = commands.test || "go test ./...";
  }

  // 2. Generate Structured QRONOS.md Content
  const content = `# QRONOS.md — Project Instructions for Qronos AI Agent

## Overview
- **Project:** ${projectName}
- **Stack:** ${techStack}

## Common Commands
${commands.dev ? `- **Development:** \`${commands.dev}\`` : "- **Development:** (configure dev command)"}
${commands.build ? `- **Build:** \`${commands.build}\`` : "- **Build:** (configure build command)"}
${commands.test ? `- **Test:** \`${commands.test}\`` : "- **Test:** (configure test command)"}
${commands.lint ? `- **Lint:** \`${commands.lint}\`` : "- **Lint:** (configure lint command)"}

## Architecture & Directory Structure
- Follow existing patterns in the codebase.
- Keep components modular, minimal, and well-typed.

## Development Guidelines
- Prefer surgical edits using the \`Edit\` tool over replacing entire files.
- Always check that tests and builds pass before marking tasks as complete.
- Adhere to the established code styling, formatting, and linting rules.
`;

  try {
    await writeFile(qronosPath, content, "utf8");
    ctx.ui.notify("✓ Successfully created QRONOS.md in current directory.", "info");
  } catch (err) {
    ctx.ui.notify(`Failed to write QRONOS.md: ${err instanceof Error ? err.message : String(err)}`, "error");
  }
}

/** CLI entry point for `qronos-cli init` */
export async function runInitCli(): Promise<number> {
  const fakeCtx = {
    cwd: process.cwd(),
    ui: {
      confirm: async (_title: string, msg: string) => {
        console.log(`\n${msg}`);
        return true;
      },
      notify: (msg: string, type?: "info" | "warning" | "error") => {
        if (type === "error") console.error(`\x1b[31m${msg}\x1b[0m`);
        else console.log(`\x1b[32m${msg}\x1b[0m`);
      },
    },
  };
  await runInit(fakeCtx as any);
  return 0;
}
