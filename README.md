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

[Start in 30 seconds](#start-in-30-seconds) · [CLI](docs/guides/cli.md) · [Cockpit](docs/guides/cockpit.md) · [Agent skill](docs/guides/agent-skill.md) · [GitHub Actions](docs/guides/github-actions.md) · [How it works](docs/guides/how-it-works.md)

</div>

---

Conclave sits after a code change and before approval. It compares the real Git change, maps the code around it, points to risks with file-and-line evidence, and hands the next action to you, your coding agent, or a human reviewer.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-pr-flow.svg" alt="A code change passes through Conclave context and evidence before human approval and merge" width="920"></p>

```text
change → Conclave review → coding agent fixes findings → Conclave rechecks → human approves → merge
```

**No API key. No source sent to a model. Read-only.** Review is deterministic code analysis; it never edits, commits, pushes, approves, or merges.

## Start in 30 seconds

You need Node.js 20+ and Git. Your project does not have to be a Node project.

```bash
npm install -g conclave-ai
conclave check .
```

That reviews your branch commits plus every staged, unstaged, and new file, and prints a summary, findings, evidence, and a prompt your coding agent can act on. Not sure what to run? Type `conclave` for a guided menu.

Prefer not to install? `npx --yes conclave-ai check .` works too.

## One engine, three ways to use it

| | Product | Best for | Start with | Guide |
| --- | --- | --- | --- | --- |
| ⌨️ | **CLI** | Reviewing from the terminal, scripts, and CI | `conclave check .` | [CLI guide](docs/guides/cli.md) |
| 🖥️ | **Cockpit** | Reading results, diffs, and history in a browser | `conclave open .` | [Cockpit guide](docs/guides/cockpit.md) |
| 🤖 | **Agent skill** | Letting Claude Code or Codex review its own work before you merge | `conclave setup .` | [Skill guide](docs/guides/agent-skill.md) |

Plus a ready-made [GitHub Actions workflow](docs/guides/github-actions.md) that comments on every pull request.

All three run the same local engine and read the same settings, so a review started in one appears in the others' history.

## What the verdict means

| Verdict | Meaning | Next action |
| --- | --- | --- |
| `PASS` | No deterministic blocker or warning found | Run your tests and ask for human review |
| `WARN` | A reviewable risk remains | Inspect or fix it, then recheck |
| `BLOCK` | Evidence contradicts the scope, claims, or structural safety | Send the handoff to your coding agent, then recheck |
| `INCONCLUSIVE` | The evidence cannot support a safe conclusion | Improve the base, objective, or criteria |

`PASS` is evidence, not approval: Conclave is not a compiler, test runner, or security scanner, and a human stays the merge authority. [How review works →](docs/guides/how-it-works.md)

## Optional: AI for Ask and Investigate

Review never needs a key. A model is used only when you ask questions about the code:

```bash
conclave init                  # provider → model → API key, three steps
conclave config set api-key    # change the key later (asked hidden)
```

Keys are saved per user in `~/.config/conclave/credentials.env` with owner-only permissions and are never sent to the browser. [All settings →](docs/guides/cli.md#settings-and-api-keys)

## Learn more

- [How review works](docs/guides/how-it-works.md): pipeline, supported languages, coverage, and when a model is worth it
- [Review lineage and receipts](docs/review-lineage.md): correction loops and attached test evidence
- [Security boundaries](docs/security.md)
- [Changelog](CHANGELOG.md) · [Roadmap](ROADMAP.md)

## Development

```bash
npm install
npm run verify
```

Contributions are welcome under the [MIT license](LICENSE). See [CONTRIBUTING.md](CONTRIBUTING.md).
