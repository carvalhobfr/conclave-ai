# Conclave CLI

[English](cli.md) · [Português (Brasil)](cli.pt-BR.md) · [← README](../../README.md)

The CLI is the Conclave engine. The [cockpit](cockpit.md), the [agent skill](agent-skill.md), and the [GitHub Action](github-actions.md) all call it.

## Install

```bash
npm install -g conclave-ai        # once, for every repository (recommended)
npm install --save-dev conclave-ai  # or per project: npx conclave check .
```

Yarn and pnpm work too: `yarn add --dev conclave-ai` or `pnpm add --save-dev conclave-ai`. You need Node.js 20+ and Git; the reviewed project can be in any language.

## You don't have to memorize anything

```bash
conclave              # guided menu
conclave help         # every command, grouped by purpose
conclave help check   # one command: what it does, options, examples
```

The guided menu keeps every action within two choices: the main list, plus **More tools…** and **Settings…** submenus. Help ships with the CLI, so it always matches your installed version.

## Everyday commands

| Command | What it does |
| --- | --- |
| `conclave check .` | Review the current branch and every local change (recommended) |
| `conclave compare .` | Pick two branches from a list and compare them without switching checkout |
| `conclave open .` | Open the [cockpit](cockpit.md) in your browser |
| `conclave history .` | List previous reviews of this repository |
| `conclave handoff .` | Print the latest correction prompt for your coding agent |
| `conclave setup .` | Install the [agent skill](agent-skill.md) and optional [GitHub workflow](github-actions.md) |
| `conclave doctor .` | Check Git, languages, skills, and CI integration |
| `conclave ask . "question"` | Answer a question about the code (needs a provider) |
| `conclave investigate . "behavior"` | Challenge hypotheses about a behavior (needs a provider) |

### What `check` does for you

- finds the repository and the likely pull-request base;
- includes branch commits, staged, unstaged, and new untracked files;
- uses the latest commit as a transparent objective when you give none;
- builds a fresh local code map (no `index` step needed);
- prints the summary, findings, affected code, evidence, and next steps;
- writes a prompt your coding agent can act on; and
- saves the full report to local history.

### Being explicit

```bash
# Current workspace against a chosen base, with a stated objective
conclave check . --base origin/main \
  --objective "Add passwordless login without breaking session restore"

# Two committed refs, without switching branches
conclave compare . --base origin/main --head feature/login \
  --objective "Add passwordless login"

# Machine-readable output for scripts or CI
conclave check . --base origin/main --json > conclave-review.json
```

### Recheck after a fix

```bash
conclave check . --base origin/main \
  --objective "Add passwordless login without breaking session restore" \
  --previous-report conclave-review.json --json > conclave-recheck.json
```

The recheck belongs to the same review series. Conclave verifies the previous report, keeps the objective and criteria fixed, and tells real progress apart from a duplicate rerun, stagnation, or regression. Use `--new-series` only to accept a new baseline on purpose. Attach external test or build results with the repeatable `--receipt` flag. See [review lineage and receipts](../review-lineage.md).

### Acceptance criteria

```bash
conclave criteria .
```

Saves the objective and criteria that `check` and `review` must satisfy. See [acceptance](../acceptance.md).

### Exit codes

| Exit | Verdict |
| ---: | --- |
| 0 | `PASS` or `WARN` |
| 1 | `BLOCK` |
| 2 | `INCONCLUSIVE` |

## Settings and API keys

Review never needs a key. A provider is used only by `ask`, `investigate`, and the cockpit's Ask and Investigate modes.

### First setup: three steps

```bash
conclave init             # provider → model → API key (input hidden)
conclave provider-check   # send one small test request
```

Supported providers: OpenCode Go (recommended low-cost default), OpenAI, OpenRouter, and Anthropic. Run `conclave models` to see the maintained model profiles. When you rerun `init` with the same provider, pressing Enter at the key prompt keeps the saved key.

Non-interactive, for scripts:

```bash
echo "$KEY" | conclave init --provider opencode-go --api-key-stdin
```

### Change one value

```bash
conclave config                              # every value and where it comes from; secrets masked
conclave config set api-key                  # asked hidden
echo "$KEY" | conclave config set api-key    # or piped
conclave config set model deepseek-v4.1-flash
conclave config set provider openrouter      # also switches mode to api
conclave config get model
conclave config unset base-url
conclave config edit                         # open the file in $EDITOR
conclave config path                         # print the file path
```

Short keys: `provider`, `model`, `api-key`, `base-url`, `reasoning`, `mode`, `fallback-model`. Any `CONCLAVE_*` name also works, for example `conclave config set judge-model <id>`.

### Where settings live

| Source | Location | Wins over |
| --- | --- | --- |
| Shell environment | `export CONCLAVE_MODEL=…` | everything |
| Project file | `./.env` (only when it already defines `CONCLAVE_*` keys) | user settings |
| User settings | `~/.config/conclave/credentials.env` | — |

User settings are written with owner-only permissions (`0600`), so a global install works in every repository. Add `--project` to `init` or `config set` to write `./.env` instead. `CONCLAVE_CONFIG_HOME` moves the settings folder.

### Interface language

```bash
conclave config --language pt-BR   # Brazilian Portuguese
conclave config --language es-ES   # Spanish (Spain)
conclave config --language en      # back to the default
```

The language applies to menus, help, prompts, and review labels. `CONCLAVE_LANGUAGE=es-ES conclave help` overrides it for one command. JSON field names always stay in English so integrations don't break.

## Update and diagnose

```bash
conclave --version
conclave update --check    # latest version on npm
conclave update --global   # update a global install
conclave update --local    # update a project dependency
conclave doctor .
```

## Advanced commands

| Command | Purpose |
| --- | --- |
| `conclave review . --working\|--staged\|--base <ref>\|--commit <sha> --objective "…" --json` | Low-level evidence gate with an exact source |
| `conclave index .` | Optional reusable cache (`.conclave/code-index-v2.json`) for search, graph, and Ask |
| `conclave search`, `symbol`, `text`, `graph`, `path`, `retrieve` | Explore the code map |
| `conclave collect`, `smoke` | Explicitly run a bounded evidence plan; see [CI evidence](../ci-evidence.md) and [browser smoke](../browser-smoke.md) |
| `conclave mcp .` | Expose Conclave to MCP clients |
| `conclave eval …` | Retrieval and reasoning evaluations |

Run `conclave help <command>` for the details of any of them.
