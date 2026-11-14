---
name: research-spike
description: "Time-boxed research before adopting a library, API, architecture, or provider. Use when asked to 'research', 'compare options', 'evaluate a library', 'spike on', 'investigate a tool', 'should we use X', or 'what are our options for'. Produces structured findings in docs/research/ with no production code changes."
version: 1.0.0
user_invocable: true
---

# Research Spike

Execute a structured, time-boxed research spike. Produces a recommendation with tradeoffs, captured in `docs/research/`, with no production code changes.

## Usage

```
/research-spike <question> [--options "A, B, C"] [--time-box 2h]
```

## Process

### Phase 1: Frame the Question
1. Restate the research question in one sentence.
2. List the options to compare (at minimum 2).
3. Define the decision criteria (cost, complexity, performance, maintenance, security).

### Phase 2: Research
1. Spawns read-only exploration agents.
2. Inspect docs, examples, source code.
3. Identify capabilities, limitations, and failure modes.

### Phase 3: Compare and Recommend
1. Build comparison matrix.
2. State clear recommendation with rationale and tradeoffs.

### Phase 4: Write Findings
Write structured report to `docs/research/<date>-<slug>.md`.
