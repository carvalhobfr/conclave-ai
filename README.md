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

[Quick start](#quick-start) · [CLI and languages](#cli-help-and-languages) · [How it works](#how-review-works-without-ai) · [Agent skill](#codex-and-claude-code-skill) · [Visual cockpit](#visual-review-cockpit) · [Changelog](CHANGELOG.md)

</div>

---

> **0.9:** `0.9.0` introduces honest rule coverage and a decision-first report. Criteria editing, verified CI provenance, behavioral collection and team collaboration remain planned. See the [0.9 product plan](docs/product-0.9.md).


Conclave sits after a code change and before approval. It compares the real Git change, maps the code around it, points to risks and evidence, and gives the next action to a developer, coding agent, or human reviewer.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-pr-flow.svg" alt="A code change passes through Conclave context and evidence before human approval and merge" width="920"></p>

```text
change → Conclave review → coding agent fixes findings → Conclave rechecks → human approves → merge
```

Conclave is deliberately read-only. It does not edit files, apply patches, execute repository scripts, commit, push, approve, or merge.

## Choose the shortest path

| I want to… | Start here |
| --- | --- |
| Review my current branch and every local change | `conclave check .` |
| Compare two branches without switching checkout | `conclave compare .` |
| Let Codex or Claude run Conclave naturally | `conclave setup .` |
| Read the result in a browser | `conclave open .` |
| Explore commands without memorizing flags | `conclave help` |

## Quick start

Requirements: Node.js 20+ and Git. Node is Conclave's runtime; the repository itself does not need to be a Node project.

```bash
npm install --save-dev conclave-ai
npx conclave check .
```

That is enough for the normal workflow. No API key and no prior index are required.

`check` is the recommended command. It automatically:

- finds the repository and likely PR base;
- includes committed branch changes, staged files, unstaged files, and new untracked files;
- infers a transparent fallback objective from the latest commit when none is supplied;
- builds a fresh local code map—no prior `index` command is required;
- prints a PR summary, findings, affected code, evidence, and next steps;
- creates a prompt that your coding agent can act on; and
- saves the full report in local review history.

Be explicit whenever you want to:

```bash
# Compare the current workspace with a chosen base
npx conclave check . --base origin/main \
  --objective "Add passwordless login without breaking session restore"

# Compare two committed refs without switching branches
npx conclave compare . --base origin/main --head feature/login \
  --objective "Add passwordless login"

# Produce machine-readable output for an agent or CI
npx conclave check . --base origin/main --json > conclave-review.json

# Recheck after a correction without moving the objective or contract silently
npx conclave check . --base origin/main \
  --objective "Add passwordless login without breaking session restore" \
  --previous-report conclave-review.json --json > conclave-recheck.json
```

The recheck belongs to the same review series. Conclave verifies the previous report digest, compares the objective and contract, fingerprints recurring findings, and distinguishes a duplicate rerun from progress, stagnation, or regression. Use `--new-series` only when you intentionally accept a new baseline. Externally run tests or builds can be attached with repeatable `--receipt`; receipts are checked against the exact artifact but remain self-reported until attestation verification is added. See [review lineage and receipts](docs/review-lineage.md).

Yarn and pnpm work too:

```bash
yarn add --dev conclave-ai && yarn conclave check .
pnpm add --save-dev conclave-ai && pnpm exec conclave check .
```

Try it without adding a dependency:

```bash
npx --yes --package=conclave-ai@latest conclave check .
```

Prefer a guided flow? Run plain `npx conclave`. Prefer to understand a command first? Run `npx conclave help check`.

## How review works without AI

Review is a deterministic code-analysis pipeline, not a chat completion.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-review-pipeline.svg" alt="Git comparison goes through a local structural index, impact graph, checks and an evidence-backed verdict" width="900"></p>

1. Git supplies the exact comparison and patch.
2. Local parsers identify files and **code units**—named functions, methods, classes, interfaces, and modules. Older docs called these “symbols.”
3. A relationship graph follows imports, exports, calls, references, containers, and consumers.
4. Deterministic checks challenge scope, changed public code without changed tests, parser-visible errors, impact outside the diff, deletions, and optional completion claims. Defects visible in the changed text are reported the same way: a resource the change acquires but the project never releases, an error thrown away by an empty catch, and a store addressed by a literal where the same file uses a named constant.
5. Conclave reports `PASS`, `WARN`, `BLOCK`, or `INCONCLUSIVE`, always with traceable file and line evidence where available.

No source is sent to an LLM during review. No API key is required. This is useful evidence, not a compiler, test runner, security scanner, runtime proof, or automatic approval. A human remains the merge authority.

### Language support

Conclave's structural parsers currently understand:

| Language | Functions/classes | Imports | Graph impact | Test-file detection |
| --- | ---: | ---: | ---: | ---: |
| TypeScript / JavaScript / TSX / JSX | Yes | Yes | Yes | Yes |
| Python | Yes | Yes | Yes | Yes |
| Java | Yes | Yes | Yes | Yes |

Other text languages still appear in Git change and scope evidence, but do not yet receive the same code-unit graph depth. See [ROADMAP.md](ROADMAP.md).

## When is a model worth the cost

A review reports which narrow rules examined the change and which questions remain open. A rule finding, or the absence of one, never verifies an entire risk dimension.

| Coverage | Meaning |
| --- | --- |
| `partial` | Applicable rules examined only their declared scope. Read `checks` and `remainingQuestions`. |
| `unchecked` | No applicable deterministic rule examined this dimension in the available source. |

`escalation.recommended` means further verification is warranted. Depending on the question, use relevant tests, human review or optional model reasoning. It never starts a model or runs a repository script. A model cannot replace runtime evidence. Historical v2 `evidenced` and `checked-clean` values remain readable with explicit limitations.

```bash
conclave check . --json | jq '.report.escalation'
```

## CLI help and languages

You do not need to memorize the CLI. Run `conclave` or `conclave start .` for the guided menu. `conclave help` shows every command grouped by purpose; `conclave help <command>` explains what one command does, when to use it, its boundaries, syntax, and practical examples:

```bash
conclave help
conclave help check
conclave help symbol
```

The help is part of the CLI itself, so it always matches the installed version.

The main commands are:

| Command | Purpose |
| --- | --- |
| `conclave check .` | Review the current branch and all local changes together |
| `conclave compare .` | Select two local or remote refs interactively |
| `conclave open .` | Open the visual review cockpit in your browser |
| `conclave setup .` | Install project skills and optional GitHub workflow |
| `conclave doctor .` | Diagnose Git, languages, skills, and CI readiness |
| `conclave history .` | See local review passes |
| `conclave handoff .` | Print the latest correction prompt for an agent |
| `conclave review ... --json` | Low-level deterministic report for scripts |
| `conclave ask ...` / `investigate` | Optional provider-backed repository reasoning |

`conclave index` is only an optional reusable cache for search, graph, and Ask. It creates `.conclave/code-index-v2.json`; review never treats that cache as the change.

### English, Portuguese, or Spanish

English is the default CLI language. Save a global user preference for Brazilian Portuguese or European Spanish from any repository:

```bash
conclave config --language pt-BR
conclave config --language es-ES
conclave config --language en       # return to the default
conclave config                     # show language and provider configuration
```

The choice applies to the guided menu, help, prompts, progress, review labels, update messages, and provider setup. It is stored in the user's Conclave config directory (`~/.config/conclave/config.json` on macOS/Linux, with XDG and Windows equivalents), not in the repository. `CONCLAVE_LANGUAGE=es-ES conclave help` overrides it for one process. JSON keys remain stable in English so skills, CI, and other integrations do not break.

## Codex and Claude Code skill

The skill is the agent workflow; the CLI is its local review engine. The skill tells Codex or Claude Code how to select the change, preserve the verdict, cite evidence, return a readable result, hand findings back for correction, and recheck. It never grants mutation authority to Conclave.

Install it in a repository with an interactive setup:

```bash
npx --yes --package=conclave-ai@latest conclave setup .
```

Or install both agent adapters non-interactively:

```bash
npx --yes --package=conclave-ai@latest conclave skill install \
  --target both --scope project --project .
```

This downloads the npm package only for the command and copies the small skill into `.agents/skills/conclave-validate` and `.claude/skills/conclave-validate`; it does not add Conclave to `package.json`. Use `--scope user` to install for your user account, or `--target portable --destination ...` for another agent.

Once installed, ask the agent naturally: “Use Conclave to review the current change before we merge.” The human-readable answer appears in the agent conversation; the exact JSON remains available when needed.

## GitHub Actions

Add the ready-to-use workflow:

```bash
npx --yes --package=conclave-ai@latest conclave setup . \
  --agents none --github-actions
```

The workflow is repository-language-independent: it checks out the PR and runs a pinned Conclave package without `npm ci` or project-specific build assumptions. It writes the job summary, creates file annotations, updates one PR comment, uploads the JSON report, and fails only for `BLOCK` or `INCONCLUSIVE`. Fork PRs still get summary and artifacts when GitHub withholds comment permission.

## Visual review cockpit

```bash
npx conclave open .
```

Conclave starts a loopback-only server, opens your browser, and loads the repository automatically. The cockpit includes the summary, findings, completion claims, affected code, exact Git diff, copyable agent handoff, raw report, and local history. Ask and Investigate are available when a provider is configured.

The UI is another view of the same engine. It cannot edit the repository or perform the correction. Stop it with `Ctrl+C`.

## Optional AI configuration

Review never needs a key. A provider is used only for the read-only `ask` and `investigate` modes:

```bash
conclave init
conclave provider-check
```

The guided setup supports OpenAI/Codex-compatible keys, OpenRouter—including OpenRouter Go plan keys—Anthropic, and OpenCode Zen, with maintained model profiles and custom model IDs. Hidden input is stored only in the local Git-ignored `.env`. Browser code never receives it.

## Update and diagnose

```bash
conclave update --check   # show the latest registry version
conclave update --local   # update a project dependency
conclave update --global  # update a global install
conclave doctor .         # verify this repository's integration
```

If already current, `conclave update` says so clearly and exits without running a missing local binary.

## Verdicts and boundaries

| Verdict | Meaning | Next action |
| --- | --- | --- |
| `PASS` | No deterministic blocker or warning was found | Run relevant tests and request human review |
| `WARN` | Reviewable risk remains | Inspect or correct it, then recheck |
| `BLOCK` | Evidence contradicts scope, claims, or structural safety | Send the handoff to a coding agent, then recheck |
| `INCONCLUSIVE` | Available evidence cannot support a safe conclusion | Improve the baseline, objective, contract, or parser evidence |

No changed files is reported as “Nothing to review,” not as a fake failure.

See the [changelog](CHANGELOG.md) for released and upcoming changes, the [roadmap](ROADMAP.md) for direction, [security boundaries](docs/security.md), [review lineage and receipts](docs/review-lineage.md), and the [validation report schema](schemas/validation-report.v2.schema.json).

## Development

```bash
npm install
npm run verify
```

Contributions are welcome under the [MIT license](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md).
