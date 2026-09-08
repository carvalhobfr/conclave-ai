# Changelog

All notable changes to Conclave are documented here. The project follows [Semantic Versioning](https://semver.org/) and the structure proposed by [Keep a Changelog](https://keepachangelog.com/).

[English](CHANGELOG.md) · [Português (Brasil)](CHANGELOG.pt-BR.md)

## [0.10.0] — 2026-09-08

- Acceptance criteria editor and guided CLI, atomic saved contracts with revision conflict detection, explicit evidence links, per-criterion correction comparison, and schema v4. Human decisions remain separate; reported runtime support is not verified provenance.

## [0.9.0] — 2026-09-08

### Added

- Decision-first cockpit with next action, findings requiring attention, missing verification evidence, correction progress and navigation to the reviewed diff and agent handoff.
- Rule-level scope, applicability, source paths and open verification questions in schema v3. CLI summaries and handoffs retain the same evidence gaps.
- A staged 0.9 product plan and a repeatable `eval:precision` regression suite.

### Changed

- The check counter includes evaluated scopes without findings; responsive headers wrap long repository paths.

- Narrow source checks use the TypeScript syntax tree, ignoring comments and strings and supporting multiline calls. Cleanup candidates must match the listener receiver/event/handler/capture, interval handle or subscription binding in the same file. Candidate matching remains syntactic, not proof of teardown execution.
- Storage-key observations distinguish storage receivers and resolve top-level literal constants. Empty catches include edits inside their bodies.
- PASS and structural claims no longer imply completion of the objective in the cockpit.
- New reports use schema v3 and partial/unchecked dimension coverage. V2 schema, history and digest-based rechecks remain supported with legacy limitations. Consumers rejecting unknown schema versions must add v3 support.

### Scope

- Criteria editing, verified CI attestations, runtime collection and hosted collaboration remain planned for later minor releases. The review engine still makes no model call or repository-script execution.

## [0.8.0] — 2026-08-18

The first release of the PR-companion line to reach npm. The previously published version is `0.2.8`.

### Added

- Deterministic defect checks that cost no model call: a resource the project never releases (listener, interval, subscription), an error discarded by an empty catch, and a store addressed by a literal where the same file uses a named constant. Each one reports the exact changed line.
- `escalation` in the report: which risk dimensions the deterministic layer evidenced, which it checked and cleared, and which it has no check for at all. The decision to spend a model call is itself deterministic.
- Guided setup for `opencode-go`, with model profiles chosen from measured cost and reliability rather than vendor ordering.
- Reasoning agents receive the changed lines themselves, so a review can see what a change does and not only where it landed.
- Schema-v2 review lineage with objective, contract, diff, artifact, previous-report, and report digests.
- Contract drift gates, explicit rebaseline series, stable finding fingerprints, and correction-loop progress/stagnation tracking.
- External evidence receipts bound to the reviewed artifact plus deterministic risk-selected challenge plans.
- `--previous-report`, repeatable `--receipt`, `--series`, and `--new-series` support in the CLI and portable validation skill.
- `conclave check`, the recommended one-command PR pass. It detects the likely base and includes branch commits, staged, unstaged, and untracked files.
- `conclave compare`, with an interactive local and remote branch selector that does not change the current checkout.
- A complete `conclave help` catalog grouped by purpose, plus detailed guides such as `conclave help check` and `conclave help symbol`.
- Global CLI language preferences with English as the default, Brazilian Portuguese (`pt-BR`), and European Spanish (`es-ES`).
- `conclave config --language <language>` and an interactive language selector in the guided menu.
- A local review cockpit with summary, findings, changed code, exact diff, history, and copyable coding-agent handoff.
- Local review history and `conclave handoff` for the correct-and-recheck loop.
- Guided `conclave setup` and portable skills for Codex, Claude Code, GitHub Actions, and other agents.
- A pull-request GitHub Actions workflow with job summaries, annotations, one maintained PR comment, and JSON artifacts.
- Structural code parsing and graph evidence for Python and Java, alongside TypeScript and JavaScript.
- `conclave doctor` for repository integration diagnostics.

### Changed

- Challenge plans budget defect probes and process signals separately. A test-gap finding no longer evicts a lifecycle-state probe from the plan.
- Report schema v2 declares `escalation` and allows up to six challenges.
- Positioned Conclave as a read-only PR companion: it supplies context, evidence, and next actions while humans retain merge authority.
- Removed autonomous Task Mode and all public repository-mutation behavior. Conclave points to problems; the developer or their coding agent performs corrections.
- Review now builds a fresh snapshot and no longer depends on `.conclave/code-index-v2.json`; the persistent index is only an optional cache for search, graph, Ask, and Investigate.
- No-change comparisons are reported as informational “Nothing to review” results instead of false blockers.
- The README is shorter, bilingual, task-oriented, and explicit about deterministic review versus optional provider-backed reasoning.
- JSON field names remain stable in English regardless of the selected human-interface language.

### Fixed

- Conclave no longer reviews its own `.conclave/` index and history as part of a change. One run's stored report used to enter the next run's change set and contaminate its risk signals.
- Git's own diff headers no longer count as risk signals. The word `index` inside `index <hash>..<hash> <mode>` made the performance dimension fire on nearly every modified file.
- A cached index describing a different repository path is rebuilt instead of failing every command, which is what happens after the repository is moved or renamed.
- Local Mode refuses a hosted reasoning role at configuration time and names the variables to change, instead of failing deep in the pipeline with an unregistered-provider error.
- `conclave config` reports environment-file keys defined more than once, where the last definition silently wins.
- Provider retry classifies a transport failure by its cause rather than by the runtime's error text, which differs across Node releases.

### Security

- Every mutating local API route verifies the request origin and JSON content type, not only the runtime settings routes. A cross-site form post could previously reach project, review, and reasoning routes.
- Receipt trust claims are conservatively treated as self-reported; Conclave never claims to have run an externally reported command.
- Mutable-worktree receipts require an artifact or diff digest and cannot rely on `HEAD` alone.
- User language preferences are stored outside the repository with owner-only file permissions.
- A repository `.env` cannot redirect or silently replace global CLI preferences.
- PR review remains local and deterministic: it does not use an API key, call a model, or run repository scripts.

## [0.2.8] — 2026-08-12

### Added

- Human-readable PR summaries with comparison, risks, changed files, verdict, and next steps.
- Guided PR workflow built around explicit Git comparisons.
- Guided CLI navigation for the main PR workflow.

### Fixed

- Branch review documentation and comparison behavior were clarified to avoid reviewing the wrong diff.

## [0.2.6] — 2026-08-12

### Added

- `conclave update --check`, `--local`, and `--global`.

### Fixed

- Updating an already current installation now returns a clear explanation instead of an `ENOENT` failure.

## [0.2.5] — 2026-08-12

### Added

- Guided CLI navigation for common Conclave workflows.
- Structural review support and documentation for Python and Java.

### Changed

- Reframed deterministic validation as one evidence-producing step in the PR workflow rather than automatic code judgment.

## [0.2.4] — 2026-08-12

### Added

- Separate English and Brazilian Portuguese READMEs.
- Repository-hosted visual diagrams for the PR flow and deterministic review pipeline.

### Changed

- Simplified the product explanation around the path from code change to human-approved merge.

## [0.2.3] — 2026-08-12

### Changed

- Clarified the branch review workflow, deterministic boundaries, and meaning of code units previously called symbols.

## [0.2.2] — 2026-08-11

### Added

- Modern guided provider setup for optional Ask and Investigate modes.
- Portable agent-skill and web-workflow validation gates.

### Fixed

- CI self-validation compares against the event base instead of blocking on an empty diff.
- Package and repository naming were aligned on `conclave-ai`.

## [0.2.1] — 2026-08-11

### Changed

- Improved the provider onboarding experience and initial npm package metadata.

## [0.2.0] — 2026-08-11

### Added

- First public npm release as `conclave-ai`.
- Deterministic validation contracts, change collection, structural impact analysis, and evidence-backed verdicts.
- Optional API configuration and a portable validation skill.

[Unreleased]: https://github.com/carvalhobfr/conclave-ai/compare/b6c5418...HEAD
[0.2.8]: https://www.npmjs.com/package/conclave-ai/v/0.2.8
[0.2.6]: https://www.npmjs.com/package/conclave-ai/v/0.2.6
[0.2.5]: https://www.npmjs.com/package/conclave-ai/v/0.2.5
[0.2.4]: https://www.npmjs.com/package/conclave-ai/v/0.2.4
[0.2.3]: https://www.npmjs.com/package/conclave-ai/v/0.2.3
[0.2.2]: https://www.npmjs.com/package/conclave-ai/v/0.2.2
[0.2.1]: https://www.npmjs.com/package/conclave-ai/v/0.2.1
[0.2.0]: https://www.npmjs.com/package/conclave-ai/v/0.2.0
