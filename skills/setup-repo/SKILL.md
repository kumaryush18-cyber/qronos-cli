---
name: setup-repo
description: "Scaffold a repository with GitHub issue templates, PR template, development process docs, TDD workflow, hooks, and CI configuration. Use when asked to 'setup a repo', 'scaffold a project', 'init project structure', 'add github templates', 'setup development process', or 'bootstrap repo'."
version: 1.0.0
user_invocable: true
---

# Setup Repo

Scaffold a repository with production-grade development infrastructure: GitHub issue templates, PR template, development process documentation, TDD workflow configuration, hooks, and CI setup.

## Usage

```
/setup-repo [--full] [--templates-only] [--hooks-only] [--process-only]
```

## Features

- **GitHub Issue Templates**: Feature slices, bug regressions, research spikes.
- **Pull Request Template**: Structured PR body with test and verification checklists.
- **Process Documentation**: Behavior-first TDD, development workflow, regression discipline.
- **Quality Gates**: Commit message discipline and CI configuration.
