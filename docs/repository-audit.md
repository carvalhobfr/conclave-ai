# Repository audit

`conclave audit [REPOSITORY]` examines a whole repository as it is on disk, with deterministic rules. It is a different operation from pull-request review: there is no diff, objective, contract or merge verdict. It makes no model call, executes no repository code, and performs no network operation. It does not create issues. Its results feed a local, human-reviewed workflow described in [finding-workflow.md](finding-workflow.md).

```sh
conclave audit .                      # human-readable, saves .conclave/audits/latest.json
conclave audit . --json --no-write    # machine-readable, writes nothing (CI, tests)
conclave audit . --fail-on medium --require-complete
conclave audit . --update-baseline    # writes .conclave-baseline.json from this audit
```

A model can be added with `--semantic`; that stage is described in [semantic-discovery.md](semantic-discovery.md). Everything below describes the deterministic audit, which is what runs without that option.

## Analysis scopes

Conclave has two scopes, and both run rules through the same pipeline (`src/analysis/`):

| Scope | Looks at | Used by |
| --- | --- | --- |
| `change` | Changed files, restricted to the lines a Git change touched | `check`, `review`, `pr`, MCP `conclave_validate`, the cockpit, `check()` |
| `repository` | Every indexed file of one snapshot, each examined whole | `audit`, `audit()` |

A repository audit does not synthesize a diff. Its files carry no changed ranges, and its report has no change set.

## Rules

A rule declares a stable id, the languages and scopes it applies to, and what a match does not establish. It reads the index and nothing else.

| Rule | Severity | Scopes | Languages | Matches |
| --- | --- | --- | --- | --- |
| `parser-diagnostic` | high | change, repository | TS/JS, Python, Java | The syntax parser reported an error |
| `discarded-error` | medium | change, repository | TS/JS, Python, Java | A handler with no statements |
| `unreleased-resource` | medium | change, repository | TS/JS, Python, Java | A listener, interval, subscription or opened resource with no cleanup candidate in the same file |
| `inconsistent-key` | medium | change, repository | TS/JS | A literal storage key that differs from the named keys the file uses |
| `unresolved-import` | medium | repository | TS/JS | A relative import that names no analyzed file and that no recorded exclusion explains, or that matches two sources |
| `import-cycle` | low | repository | TS/JS | Files that import each other at load time (type-only imports ignored) |

Review-only checks are not audit rules, because their meaning depends on a change: scope expansion, impact outside the diff, exported change without a test change, deleted behavior, claims, receipts and contract drift.

A match is an observation with source evidence. It is not a confirmed defect, and the absence of a match is not evidence of correctness. `// conclave-ignore: <rule>` on the line or the line above keeps the finding in the report, marked `suppression`, and out of the counts and exit code.

## Findings

Each finding records separate facts that do not imply one another:

| Field | Meaning | Set by an audit |
| --- | --- | --- |
| `status.ruleMatched` | A deterministic rule matched | always `true` |
| `status.evidence` | Source locations are attached | always `source-located` |
| `status.reproduction` | The problem was observed happening | always `not-attempted` |
| `status.humanConfirmation` | A person judged it real | always `none` |
| `status.publication` | A person approved publishing it | always `not-requested` |

`origin` is always `deterministic-rule`. Model output is never recorded as an audit finding.

`evidenceDigest` is a digest of the source text at the evidence locations, without line numbers: it changes when that text changes and not when the code moves. Finding text that quotes the source has recognized credential formats replaced by `[REDACTED:credential]`.

`fingerprint` identifies a finding across audits: rule, file, enclosing symbol and the flagged line with whitespace collapsed. Unrelated edits elsewhere in the file do not change it; editing the flagged line or renaming the enclosing symbol does. Identical statements in one symbol are numbered in source order. Findings are ordered by path, line, rule.

## Coverage

`coverage.status` is `partial` when a file of a supported language exists and was not analyzed (withheld for safety, parser failure, oversized, unreadable, binary, symlink), or when the index recorded no coverage. Otherwise it is `supported-source-analyzed`, which says only that. No report describes a repository as clean or verified.

### What the counts mean

`coverage.accounting` counts files, each with one meaning:

| Field | Counts |
| --- | --- |
| `filesDiscovered` | Individual files the walk reached. A symbolic link is one file |
| `filesAnalyzed` | Files parsed and given to the rules |
| `filesNotAnalyzed.ignored` | Files matched by an ignore rule by name |
| `filesNotAnalyzed.safetyExcluded` | Files withheld by a credential safeguard, by name or by content |
| `filesNotAnalyzed.unsupported` | Files of a type without a parser |
| `filesNotAnalyzed.parserFailure` | Files the parser failed on |
| `filesNotAnalyzed.unexamined` | Binary, oversized, unreadable files and symbolic links |
| `eligibleSourceFiles` | Discovered, non-ignored files of a supported language |
| `ignoredDirectories` | Ignored directories, one entry each |

Invariants, enforced by tests:

- `filesAnalyzed` plus the five `filesNotAnalyzed` values equals `filesDiscovered`. That is a partition: one reason per file.
- `metrics.filesExcluded` equals the sum of `filesNotAnalyzed`.
- `eligibleSourceFiles` is **not** part of the partition. It overlaps it: a source file withheld for safety counts under `safetyExcluded` and as eligible source.
- `coverage.excluded` counts skipped **entries** per recorded reason, and an ignored directory is one entry. Its values sum to the `filesNotAnalyzed` total plus `ignoredDirectories`, so they exceed `filesDiscovered - filesAnalyzed` whenever a directory was ignored.
- Files inside an ignored directory are never listed. They are in no file count, and the percentage of files analyzed does not include them in either term.

No count removes an excluded file from the denominator. Counts describe one snapshot: adding or removing a file changes them, so a number from an earlier run of a working tree need not match a later one.

## Exit codes

These describe an audit run. They are unrelated to review verdicts.

| Code | Meaning |
| ---: | --- |
| 0 | The audit ran and no counted finding reached `--fail-on` (default `high`) |
| 1 | At least one counted finding reached `--fail-on` |
| 2 | `--require-complete` was given and coverage is partial |
| 3 | The audit could not run; no report was produced |

A finding is counted unless it is suppressed inline, listed in the baseline, or exempted by an applicability declaration with `gate: false`. `summary.baselined`, `summary.exempt` and `summary.gated` add up to `summary.findings`; all of them stay in the report.

## Report

`--json` prints an object described by [`schemas/audit-report.v1.schema.json`](../schemas/audit-report.v1.schema.json): analyzer, repository, snapshot, conclusion, coverage, summary, findings, every rule with its status, metrics, and the trust boundary. `snapshot.id` is a digest of the analyzed files' contents and of the files left unanalyzed; `snapshot.headCommit` is the checked-out commit, when there is one, and does not by itself identify the audited content, because uncommitted edits are audited too.

The pull-request report schema is unchanged. Audit results use their own schema because a snapshot has no diff, lineage or verdict to put in the review schema's required fields.

## State

By default the report is saved to `.conclave/audits/latest.json` and the run is recorded in the finding ledger at `.conclave/findings/ledger.json` (both ignored by Git and by the next audit). `--no-write` saves neither. `.conclave-baseline.json` is written only by `--update-baseline`. The library function `audit()` writes nothing unless `write: true` is passed. The index is built in memory with the local deterministic embedding; the configured embedding or reasoning provider is never used.

## From the cockpit

`conclave open .` shows the same audit under **Repository audits** ([guide](guides/cockpit.md#repository-audits-static-smart-and-deep)). The loopback server runs the function the CLI runs, with `write: true`, so the report, the ledger and the semantic cache are the files described above.

| Mode | Equivalent command | Model calls |
| --- | --- | --- |
| Static | `conclave audit .` | None. Needs no provider and makes no network request |
| Smart | `conclave audit . --semantic` | Discovery, then one verifier call per hypothesis |
| Deep | `conclave audit . --semantic --deep` | Discovery, then the reasoning roles on each hypothesis |

| Route | Purpose |
| --- | --- |
| `GET /api/audit/preflight?projectId=&mode=` | What that mode would call and send: provider host, models, privacy boundary, budget, cached regions. Reads configuration only and calls no model |
| `POST /api/audit/start` | Starts one audit job and returns at once. `smart` and `deep` are refused with `acknowledgement_required` unless the body carries `acknowledgedModelCalls: true` |
| `GET /api/audit/status?projectId=` | The job: `running`, `completed` or `failed`, with its last 60 progress lines |
| `GET /api/audit/latest?projectId=` | The saved report of the last audit, or `null` |
| `GET /api/audit/runs?projectId=` | The runs recorded in the ledger |
| `GET /api/architecture?projectId=` | Files, symbols, modules and resolved relations from the index. Deterministic |

One audit runs per repository at a time; a second start answers `audit_running`. The job record lives in the server's memory: restarting the server forgets a running job, while everything an audit already saved stays on disk. Budget values must be whole numbers, and model names are length-limited text; anything else is refused as `invalid_request`. `--fail-on`, `--require-complete`, `--update-baseline`, `--no-write` and the price options exist only in the CLI.

## Measuring

`npm run bench:audit` audits this repository several times and prints files, graph size, import resolution, time per phase, memory and matches per rule.
