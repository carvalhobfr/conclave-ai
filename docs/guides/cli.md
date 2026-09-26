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

### Options for `check`, `compare`, and `review`

| Option | Meaning |
| --- | --- |
| `--base <ref>` | Base to compare against (default: detected pull-request base) |
| `--head <ref>` | Target ref for a two-ref comparison (`compare`, `review --base`) |
| `--objective "<text>"` | What the change must deliver; frozen across a review series |
| `--contract <file>` | JSON with allowed paths and completion claims to verify |
| `--previous-report <file>` | Continue a review series from an earlier `--json` output |
| `--new-series` | Accept a new baseline on purpose (not with `--previous-report`) |
| `--series <id>` | Assert the expected series ID |
| `--receipt <file>` | Attach an external test or build result (repeatable) |
| `--attested-receipt <file>` | Attach a CI-attested receipt (with `--attestation-repository` and `--attestation-workflow`) |
| `--working`, `--staged`, `--commit <sha>` | `review` only: pick an exact source |
| `--json` | Print `{ summary, report, handoff }` instead of text |
| `--debug` | Print extra diagnostics |

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

### Local models

Keep everything on your machine with [Ollama](https://ollama.com) or [LM Studio](https://lmstudio.ai):

```bash
ollama pull qwen2.5-coder:3b
conclave config set provider ollama         # also sets mode to local
conclave config set model qwen2.5-coder:3b
conclave provider-check
```

For LM Studio use `provider lm-studio` and the model ID it shows. Custom local endpoints go in `base-url` and must use a loopback address.

### Per-role models

Ask and Investigate run up to five roles: investigator, skeptic, architect, verifier, and judge. Each can use its own model, and a fallback model steps in when the main one fails:

```bash
conclave config set judge-model deepseek-v4-pro
conclave config set fallback-model deepseek-v4.1-flash
conclave config set reasoning free-like      # fast: skip the architect role
```

A role on a different provider needs that provider's own key, for example `CONCLAVE_OPENCODE_ZEN_API_KEY`. The cockpit's saved Conclaves set these for you.

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

## Environment variables

Every setting can come from the shell, a project `.env`, or user settings (`conclave config`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `CONCLAVE_MODE` | `free` | `api`, `local`, or `free` |
| `CONCLAVE_PROVIDER` | — | `opencode-go`, `openai`, `anthropic`, `openrouter`, `opencode-zen`, `ollama`, `lm-studio`, `openai-compatible` |
| `CONCLAVE_MODEL` | — | Model ID for every role |
| `CONCLAVE_API_KEY` | — | Provider key |
| `CONCLAVE_BASE_URL` | provider default | Endpoint (HTTPS, or loopback in local mode) |
| `CONCLAVE_REASONING_PRESET` | by mode | `full`, `free-like` (faster), or `local`; defaults to `full` in api mode |
| `CONCLAVE_FALLBACK_MODEL` | — | Model used when the main one fails |
| `CONCLAVE_<ROLE>_PROVIDER`, `CONCLAVE_<ROLE>_MODEL`, `CONCLAVE_<ROLE>_FALLBACK_MODEL` | main values | Per-role overrides; roles are `INVESTIGATOR`, `SKEPTIC`, `ARCHITECT`, `VERIFIER`, `JUDGE` |
| `CONCLAVE_<PROVIDER>_API_KEY` | — | Key used only for that provider, e.g. `CONCLAVE_OPENCODE_ZEN_API_KEY` |
| `CONCLAVE_EMBEDDING_MODE` | `feature-hash` | `openai-compatible` enables learned embeddings for search |
| `CONCLAVE_EMBEDDING_MODEL`, `_BASE_URL`, `_DIMENSIONS`, `_API_KEY` | — | Learned embedding settings |
| `CONCLAVE_LANGUAGE` | saved preference | `en`, `pt-BR`, or `es-ES` for one process |
| `CONCLAVE_CONFIG_HOME` | `~/.config/conclave` | Settings folder |
| `CONCLAVE_WEB_PORT` | `4317` | Port when running the web server directly |
| `CONCLAVE_TIMEOUT_MS` | `300000` | Agent skill runner timeout |
| `CONCLAVE_CLI_PATH`, `CONCLAVE_BIN` | — | Point the agent skill at a specific Conclave |

## Files Conclave writes

| Path | Contents | Commit it? |
| --- | --- | --- |
| `.conclave/` | Code map cache, review history, criteria, finding feedback | No, add it to `.gitignore` |
| `~/.config/conclave/credentials.env` | Provider settings and keys (`0600`) | Never |
| `~/.config/conclave/config.json` | Interface language | — |
| `.claude/skills/`, `.agents/skills/` | Agent skill, from `conclave setup` | Yes, to share with your team |
| `.github/workflows/conclave-review.yml` | Pull-request workflow, from `conclave setup` | Yes |

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
