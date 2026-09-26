<div align="center">

# Conclave

### A PR companion that turns code changes into reviewable evidence.

**Conclave simplifies and protects the path from changed code to human-approved merge.**

[English](README.md) · [Português (Brasil)](README.pt-BR.md)

[![npm](https://img.shields.io/npm/v/conclave-ai?logo=npm&color=CB3837)](https://www.npmjs.com/package/conclave-ai)
[![npm downloads](https://img.shields.io/npm/dm/conclave-ai?logo=npm&label=downloads%2Fmonth&color=CB3837)](https://www.npmjs.com/package/conclave-ai)
[![Node.js 20+](https://img.shields.io/badge/node-%3E%3D20-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-4C1)](LICENSE)
[![Changelog](https://img.shields.io/badge/changelog-release%20history-8B5CF6)](CHANGELOG.md)

[Quick start](#quick-start) · [CLI](docs/guides/cli.md) · [Cockpit](docs/guides/cockpit.md) · [Agent skill](docs/guides/agent-skill.md) · [GitHub Actions](docs/guides/github-actions.md) · [FAQ](#faq)

</div>

---

Conclave sits between a code change and its approval. It compares the real Git change, maps the code around it, and reports risks with file-and-line evidence, then hands the next action to you, your coding agent, or a human reviewer.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-pr-flow.svg" alt="A code change passes through Conclave context and evidence before human approval and merge" width="920"></p>

```text
change → Conclave review → coding agent fixes findings → Conclave rechecks → human approves → merge
```

## Contents

- [Why Conclave](#why-conclave)
- [Install](#install)
- [Quick start](#quick-start)
- [One engine, three ways to use it](#one-engine-three-ways-to-use-it)
- [Recipes](#recipes)
- [Verdicts and exit codes](#verdicts-and-exit-codes)
- [Configuration](#configuration)
- [Privacy and security](#privacy-and-security)
- [How it compares](#how-it-compares)
- [FAQ](#faq)
- [Troubleshooting](#troubleshooting)
- [Documentation](#documentation)

## Why Conclave

- **Reviews the change you actually have.** Branch commits, staged, unstaged, and brand-new files in one pass, against an automatically detected base.
- **Follows the blast radius.** A local code graph finds callers, importers, and consumers of what you changed, including files outside the diff.
- **Evidence, not vibes.** Every finding points to a file and line and says what to do next. No finding claims more than its rule checked.
- **Built for coding agents.** Each review produces a correction prompt, and rechecks tell real progress apart from the same diff resubmitted, stagnation, or regression.
- **Private and free by default.** Review runs locally and deterministically: no API key, no source sent to a model, no telemetry.
- **Read-only.** Conclave never edits, commits, pushes, approves, or merges.
- **Any repository.** Deep analysis for TypeScript, JavaScript, Python, and Java; every other text file still counts for scope and diff evidence.

## Install

Requirements: **Node.js 20+** and **Git**. The reviewed project can use any language.

```bash
npm install -g conclave-ai          # recommended: one install for every repository
```

Other options:

```bash
npm install --save-dev conclave-ai  # per project, then: npx conclave check .
yarn add --dev conclave-ai          # then: yarn conclave check .
pnpm add --save-dev conclave-ai     # then: pnpm exec conclave check .
npx --yes conclave-ai check .       # run once without installing
```

Check the install with `conclave --version` and `conclave doctor .`.

## Quick start

```bash
cd your-repository
conclave check .
```

Example output for a branch that added a password parameter to `login()`:

```text
PR summary: Update src/auth.ts
Comparison: Current workspace compared with master
This change updates 1 file, touches 1 code units, and may affect 2 files through local dependencies.
Verdict: WARN

Risks:
- WARNING: Changed code has an empty catch block
- WARNING: The change affects code outside the diff
- WARNING: Exported behavior changed without a test change

Next steps:
- Review the findings, correct confirmed problems and collect the missing verification evidence.

Next for your coding agent:
Address the Conclave review findings below.
  - src/auth.ts:2: Changed code has an empty catch block
  - src/app.ts:1: explicit named import login
  - src/auth.ts:1: Changed exported symbol without changed test evidence
```

The full report also lists what still needs verification and the independent challenges worth running, and it is saved to local history.

Not sure what to run? Type `conclave` for a guided menu, or `conclave help <command>` for any command.

## One engine, three ways to use it

| | Product | Best for | Start with | Guide |
| --- | --- | --- | --- | --- |
| ⌨️ | **CLI** | Terminal, scripts, and CI | `conclave check .` | [CLI guide](docs/guides/cli.md) |
| 🖥️ | **Cockpit** | Reading results, diffs, and history in a browser | `conclave open .` | [Cockpit guide](docs/guides/cockpit.md) |
| 🤖 | **Agent skill** | Letting Claude Code or Codex review its own work before you merge | `conclave setup .` | [Skill guide](docs/guides/agent-skill.md) |

Plus a ready-made [GitHub Actions workflow](docs/guides/github-actions.md) that comments on every pull request. All of them run the same local engine and share settings and history.

## Recipes

**Review before you open a pull request**

```bash
conclave check . --objective "Add passwordless login without breaking session restore"
```

**Compare two branches without switching checkout**

```bash
conclave compare .                                     # pick from a list
conclave compare . --base origin/main --head feature/login --objective "Add passwordless login"
```

**Hand findings to your coding agent and recheck**

```bash
conclave check . --json > review.json
conclave handoff .                                     # prompt to paste into your agent
# …agent fixes…
conclave check . --previous-report review.json         # same series: progress, stagnation, or regression
```

**Let your agent do it for you**

```bash
conclave setup .
# then ask Claude Code or Codex: "Is this ready to merge? Check with Conclave."
```

**Gate CI on the verdict**

```bash
conclave setup . --agents none --github-actions        # or, in any CI:
conclave check . --base origin/main --json > conclave.json   # exit 1 = BLOCK, 2 = INCONCLUSIVE
```

**Script against the report**

```bash
conclave check . --json | jq '.report.findings[] | {severity, title, file: .evidence[0].path, line: .evidence[0].startLine}'
```

The JSON has three top-level fields: `summary`, `report` (see the [schema](schemas/validation-report.v5.schema.json)), and `handoff`. Field names are stable and always in English.

## Verdicts and exit codes

| Verdict | Exit | Meaning | Next action |
| --- | ---: | --- | --- |
| `PASS` | 0 | No deterministic blocker or warning found | Run your tests and ask for human review |
| `WARN` | 0 | A reviewable risk remains | Inspect or fix it, then recheck |
| `BLOCK` | 1 | Evidence contradicts the scope, claims, or structural safety | Send the handoff to your coding agent, then recheck |
| `INCONCLUSIVE` | 2 | The evidence cannot support a safe conclusion | Improve the base, objective, or criteria |

`PASS` is evidence, not approval. A comparison with no changed files reports "Nothing to review". [How review works →](docs/guides/how-it-works.md)

## Configuration

Review needs **no configuration and no key**. A model is only used by the optional Ask and Investigate modes:

```bash
conclave init                               # provider → model → API key, three steps
conclave config                             # show every setting and where it comes from
conclave config set api-key                 # change the key (asked hidden)
conclave config set model deepseek-v4.1-flash
conclave config --language pt-BR            # interface in Portuguese or Spanish (es-ES)
```

| Provider | Notes |
| --- | --- |
| OpenCode Go | Recommended low-cost default |
| OpenAI, Anthropic, OpenRouter | Maintained model profiles; any model ID works |
| Ollama, LM Studio | Fully local, nothing leaves your machine; see [local models](docs/guides/cli.md#local-models) |

Settings live per user in `~/.config/conclave/credentials.env` (owner-only permissions). Shell environment variables win, then a project `.env`, then user settings. [Every setting and environment variable →](docs/guides/cli.md#settings-and-api-keys)

## Privacy and security

| | Review (`check`, `compare`, `review`) | Ask / Investigate |
| --- | --- | --- |
| Source sent to a model | Never | Bounded excerpts, only to the provider you configured |
| Network calls | None | Your provider only |
| API key needed | No | Yes (or a local model) |
| Repository scripts executed | Never | Never |
| Telemetry | None | None |

Conclave writes only to `.conclave/` in your repository (code map cache, history, criteria) and to your user settings folder. The cockpit listens on `127.0.0.1` only, and the browser never receives your API key. See [security boundaries](docs/security.md).

## How it compares

| | Finds | Needs | Conclave's role |
| --- | --- | --- | --- |
| Type checker / linter | Type errors, style, known bad patterns | Build setup | Complementary. Attach their results to a review with `--receipt`. |
| Test suite | Behavior regressions it covers | Tests | Complementary. Conclave flags changed public code without changed tests. |
| AI code reviewer | Anything, with variable accuracy | Sending code to a model | Conclave is deterministic and local; model reasoning is opt-in and kept separate from the verdict. |
| **Conclave** | Scope drift, blast radius, missing tests, swallowed errors, unfinished claims | Git | Evidence and a next action for the human or agent who decides. |

## FAQ

**Does Conclave send my code anywhere?**
Not during review. Only Ask and Investigate call a model, and only the provider you configured. With Ollama or LM Studio nothing leaves your machine.

**Is it free?**
Yes, MIT licensed, and review costs nothing to run. Optional Ask and Investigate cost whatever your provider charges; the Essential preset measured about $0.0015 per run in our product lab.

**My project isn't JavaScript. Does it work?**
Yes. Node.js is only Conclave's runtime. TypeScript, JavaScript, Python, and Java get the full code graph; other languages get diff, scope, and file-level evidence.

**Should I commit `.conclave/`?**
No. Add `.conclave/` to your `.gitignore`; it holds the local cache and review history.

**Does `PASS` mean I can merge?**
No. It means the deterministic checks found no blocker or warning. Run your tests and have a person review. Conclave never approves or merges.

**Can it fix the problems it finds?**
No, by design. It writes a correction prompt for your coding agent and rechecks the result.

**How is this different from asking an AI to review my PR?**
The verdict comes from deterministic rules with cited evidence, so the same change always gets the same answer and a confident-sounding model can't talk it into approval.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| `Nothing to review` | No changes against the detected base. Pass one explicitly: `conclave check . --base origin/main`. |
| Wrong base branch detected | Use `--base <ref>`. Run `git fetch` first if the base is a remote branch. |
| `conclave: command not found` | Install globally (`npm install -g conclave-ai`) or use `npx conclave`. |
| Ask says a key or model is missing | Run `conclave init`, then `conclave provider-check`. |
| A setting refuses to change | `conclave config` shows where each value comes from; a shell variable or project `.env` wins over user settings. |
| Cockpit port already in use | `conclave open . --port 4318` |
| Agent skill times out on a large repository | Set `CONCLAVE_TIMEOUT_MS=600000` (the default is 300000). |
| Anything else | `conclave doctor .` checks Git, languages, skills, and CI. [Open an issue](https://github.com/carvalhobfr/conclave-ai/issues) with its output. |

## Documentation

| Guide | What's inside |
| --- | --- |
| [CLI](docs/guides/cli.md) | Every command, options, settings, environment variables, local models |
| [Cockpit](docs/guides/cockpit.md) | Browser interface, saved Conclaves, three-click flows |
| [Agent skill](docs/guides/agent-skill.md) | Claude Code and Codex setup, prompts, correction loop, MCP |
| [GitHub Actions](docs/guides/github-actions.md) | Pull-request workflow and CI evidence |
| [How it works](docs/guides/how-it-works.md) | Pipeline, supported languages, coverage, when a model is worth it |
| [Review lineage](docs/review-lineage.md) | Correction series, receipts, rebaselines |
| [Security](docs/security.md) | Trust boundaries and threat model |
| [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md) | Releases and direction |

## Contributing

```bash
git clone https://github.com/carvalhobfr/conclave-ai.git
cd conclave-ai
npm install
npm run verify      # typecheck, lint, build, tests, evaluations, audit
```

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
