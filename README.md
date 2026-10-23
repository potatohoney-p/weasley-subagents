<div align="center">
  <img src="assets/weasley-subagents-mark.png" width="112" alt="Weasley Subagents mark">
  <h1>Weasley Subagents</h1>
  <p>Focused agent orchestration for Pi: delegate, parallelize, review, and observe work without losing control of the parent session.</p>
</div>

![Weasley Subagents orchestration network](assets/weasley-subagents-hero.png)

Weasley Subagents is an open-source Pi extension for coordinating specialized child agents. It supports foreground and background delegation, parallel review, sequential chains, saved workflows, bounded execution, worktree isolation, lifecycle artifacts, and a terminal fleet view.

## Why use it?

- Keep the parent agent focused while specialists investigate, implement, or review.
- Run independent reviewers concurrently and combine their findings.
- Chain agents with explicit handoffs and output contracts.
- Track long-running work through stable JSON lifecycle artifacts.
- Enforce tool, model, turn, usage, and concurrency boundaries.
- Keep orchestration local by default; session sharing is always explicit.

## Requirements

- Node.js 22.19 or newer
- Pi from `@earendil-works/pi-coding-agent`
- Access to at least one model configured in Pi

## Install

Use Pi's package manager:

```bash
pi install npm:weasley-subagents
```

Or use the package CLI. The CLI asks Pi to install the exact npm version that invoked it, so installation never follows an unpinned Git branch:

```bash
npx weasley-subagents
```

Project-local installation:

```bash
npx weasley-subagents --project
```

Remove the managed package while preserving user configuration and run artifacts:

```bash
npx weasley-subagents --remove
```

The removal command delegates to `pi remove`; it does not recursively delete extension directories.

## Start delegating

Ask Pi naturally:

```text
Use scout to map the authentication flow, then ask planner for a safe change plan.
```

```text
Run three reviewers in parallel: correctness, tests, and unnecessary complexity.
```

```text
Have worker implement the approved plan, then ask reviewer to inspect the diff.
```

The extension also exposes a structured `subagent` tool for precise automation:

```ts
subagent({ agent: "reviewer", task: "Review the current diff for correctness." })
```

```ts
subagent({
  tasks: [
    { agent: "reviewer", task: "Check correctness." },
    { agent: "reviewer", task: "Check test coverage." }
  ],
  concurrency: 2
})
```

```ts
subagent({
  chain: [
    { agent: "scout", task: "Map the data flow." },
    { agent: "planner", task: "Use {previous} to produce an implementation plan." }
  ]
})
```

For background work, pass `async: true`. Inspect it with `subagent({ action: "status" })` or wait for completion with `subagent_wait` when the current turn requires the result.

For a scoped fan-in across independently launched async runs, use `subagent_wait({ ids: ["run-a", "run-b"], all: true })`. Omit `all` to wait for the first selected completion or attention. The selection uses 1–100 unique exact async IDs from the current session and excludes unrelated work; already-terminal selected runs do not extend the wait. Use `id` instead for one prefix or remembered detached foreground run.

## Built-in roles

| Role | Purpose |
| --- | --- |
| `scout` | Fast codebase reconnaissance and risk mapping |
| `researcher` | Source-backed documentation and web research |
| `planner` | Concrete implementation planning without edits |
| `worker` | Scoped implementation and validation |
| `reviewer` | Diff review, tests, edge cases, and small fixes |
| `context-builder` | Deeper context assembly for complex work |
| `oracle` | Read-only second opinion and assumption challenge |
| `delegate` | Lightweight general delegation |

Agents can be defined at package, user, or project scope. Project definitions can live in `.pi/agents/`; user definitions can live in `~/.pi/agent/agents/`.

## Configuration

Primary settings live in Pi's user or project settings under `subagents`. Extension runtime controls live here:

```text
~/.pi/agent/extensions/weasley-subagents/config.json
```

Example:

```json
{
  "asyncByDefault": false,
  "fleetView": true,
  "fleetViewPlacement": "belowEditor",
  "maxSubagentDepth": 1,
  "globalConcurrencyLimit": 4,
  "artifactDir": "project",
  "parallel": {
    "maxTasks": 8,
    "concurrency": 4
  },
  "scheduledRuns": {
    "enabled": false
  }
}
```

Older `~/.pi/agent/extensions/subagent/config.json` files are read as a migration fallback. The next configuration update is written to the Weasley path; the legacy file is never deleted automatically.

Common settings include:

- `defaultModel`, `defaultThinking`, and `agentOverrides`
- `modelScope` for provider/model allowlists
- `watchdog` for opt-in adversarial review
- `turnBudget`, `toolBudget`, and `usageBudget`
- `parallel`, `chain`, and `globalConcurrencyLimit`
- `artifactDir`, `fleetView`, and `fleetViewPlacement`
- `intercomBridge` for parent/child coordination

Invalid safety-critical limits fail closed instead of silently becoming unbounded.

### Writer budget guidance

As a conservative orchestration policy, do not pass `turnBudget`, a hard `toolBudget`, or a tight `usageBudget` to mutation-capable workers. The default tool budget blocks read/search tools rather than mutation tools, so a hard cap can interrupt the evidence-gathering needed to finish safely. Ask a writer to checkpoint after the current tool returns and report changed files, build/test state, and commit or PR state. An elapsed timeout is not a mutation-safe boundary.

When a hard turn limit is reached during a tool-using turn, termination occurs at the next assistant boundary. The lifecycle state reports `termination-deferred` until that safe boundary is reached.

## Session sharing

Sharing is off unless a tool call explicitly passes `share: true`. That action exports the child session to HTML and creates a secret GitHub Gist through an authenticated `gh` CLI. Without additional configuration, the returned link is the Gist URL itself.

An optional viewer is supported only through an explicit HTTPS template:

```bash
export WEASLEY_SUBAGENTS_SHARE_VIEWER_URL='https://viewer.example/session/{gistId}'
```

The template must contain `{gistId}`, use HTTPS, and contain no embedded credentials. No third-party viewer endpoint is hardcoded.

## Artifacts and observability

Project-scoped runs write under `.weasley-subagents/` by default. Async runs expose stable lifecycle files such as:

- `status.json` — current state and step summaries
- `events.jsonl` — append-only lifecycle events
- `output-<index>.log` — bounded child output
- `subagent-log-<runId>.md` — human-readable run summary

Treat these files as local operational data. They are ignored by this repository and should not be committed unless deliberately sanitized.

## Safety model

- Child agents do not automatically become orchestrators.
- Tool and extension access can be narrowed per agent.
- Worktree mode isolates parallel writers and records their diffs.
- Completion and acceptance guards distinguish attempted work from verified work.
- Spawn, depth, concurrency, turn, tool, and usage budgets can constrain runs.
- Scheduled execution is disabled by default.
- Sharing requires an explicit per-run request.

Subagents still execute model-generated actions. Review requested permissions, keep credentials out of prompts and repositories, and use the narrowest useful tool set.

## Public APIs

The package exports:

```ts
import weasleySubagents from "weasley-subagents";
import { registerBackgroundWorkProvider } from "weasley-subagents/background-work";
import { registerSubagentCapabilityCeiling } from "weasley-subagents/capability-ceiling";
```

It also exposes delegation and preflight APIs for integrations that need programmatic orchestration and launch validation.

## Development

```bash
npm ci
npm test
npm run test:integration
npm run test:e2e
npm run typecheck
npm run pack:check
```

Before opening a pull request, run the smallest relevant test first, then `npm run test:all` and `npm run typecheck`.

## Community

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing changes.
- Report vulnerabilities privately using [SECURITY.md](SECURITY.md).
- Participate under the [Code of Conduct](CODE_OF_CONDUCT.md).
- Use [GitHub issues](https://github.com/potatohoney-p/weasley-subagents/issues) for reproducible bugs and scoped feature requests.

## License

Copyright 2026 Weasley Open Source.

Licensed under the [Apache License 2.0](LICENSE). See [NOTICE](NOTICE) for attribution information.
