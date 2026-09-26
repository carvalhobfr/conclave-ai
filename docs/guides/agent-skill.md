# Conclave agent skill

[English](agent-skill.md) · [Português (Brasil)](agent-skill.pt-BR.md) · [← README](../../README.md)

The skill teaches Claude Code and Codex to review their own work with Conclave before you merge. The agent picks the change, runs the [CLI](cli.md), keeps the verdict exactly as reported, cites evidence, and hands findings back for a fix and recheck.

## Install

In the repository, pick your agents and optionally the GitHub workflow:

```bash
conclave setup .
```

Or install directly, without questions:

```bash
conclave skill install --target both --scope project --project .
```

| Option | Values |
| --- | --- |
| `--target` | `claude` (`.claude/skills/`), `codex` (`.agents/skills/`), `both`, or `portable --destination <dir>` for other agents |
| `--scope` | `project` (this repository, can be committed for your team) or `user` (every repository on your machine) |
| `--force` | Replace an existing, different copy |

Without a global install, prefix with `npx --yes --package=conclave-ai@latest`; nothing is added to `package.json`.

## Use it

Just ask in plain language:

- "Use Conclave to review the current change before we merge."
- "Is this ready to merge?"
- "Did you really finish? Check with Conclave."
- "Compare `feature/login` against `main` with Conclave."

The agent replies with:

1. the verdict and summary;
2. the most important finding, with file and line;
3. the next action; and
4. what stayed unverified.

Its own reading of the code appears under a separate "model review" heading and never changes Conclave's verdict. Ask for the raw JSON whenever you want it.

## The correction loop

```text
review → agent fixes cited findings → recheck with --previous-report → you approve
```

On `BLOCK`, `WARN`, or `INCONCLUSIVE`, the agent returns the evidence and the correction prompt, fixes, and reviews again in the same series. Conclave flags a rerun of the identical diff, findings that don't go away, and regressions.

## Rules the skill enforces

- `BLOCK` and `INCONCLUSIVE` are never presented as approval, and `WARN` is never called fully proven.
- Agent confidence or a "done" message is never treated as evidence.
- Repository scripts are not run unless you authorize them. The agent asks you to run your own type checker and linter and attaches the results as receipts.
- The agent never reads, prints, or sets API keys. Review doesn't need one.

## How the skill finds Conclave

In order:

1. `CONCLAVE_CLI_PATH`;
2. a `dist/cli.js` whose `package.json` is `conclave-ai` (another project's own CLI is never executed);
3. `CONCLAVE_BIN`;
4. a global `conclave` on `PATH`;
5. `npx`, pinned to the skill's version.

Install globally (`npm install -g conclave-ai`) so reviews start without a download. The first review of a large repository builds its code map; raise `CONCLAVE_TIMEOUT_MS` above the 300000 ms default if needed.

## MCP

Clients that speak MCP can call Conclave as a tool instead:

```bash
conclave mcp /path/to/repository
```

The skill prefers the `conclave_validate` MCP tool when it is available and applies the same rules to its report.
