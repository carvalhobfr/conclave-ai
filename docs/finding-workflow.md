# Findings, triage and issue proposals

`conclave audit` reports what deterministic rules matched in one snapshot. This workflow turns those results into something that persists and that people decide on: a finding ledger, human classifications, and issue proposals that a person approves explicitly.

Everything is local. No command here calls a model, a network or GitHub, and there is no `issues publish`.

```sh
conclave audit .                                   # records the run in the ledger
conclave findings list                             # what is open, and its state
conclave findings show 3f9a1c20b7 --source         # one finding, with the source lines
conclave findings classify 3f9a1c20b7 --as confirmed --note "Listener is never removed"
conclave issues propose 3f9a1c20b7                 # a local draft
conclave issues show 8c41d0e2aa                    # read the exact text and its revision
conclave issues submit 8c41d0e2aa
conclave issues approve 8c41d0e2aa --revision rev_5b1f0c9d2e7a
conclave issues ready 8c41d0e2aa                   # checks every publication requirement
```

Every command takes `--repo PATH` (default `.`) and `--json`. An id may be given in full or as any unique leading part of at least six characters.

## Five separate facts

| Fact | Set by | Recorded in |
| --- | --- | --- |
| A deterministic rule matched | the audit | the finding exists |
| Source evidence was collected | the audit | `evidence`, `evidenceDigest` |
| The problem was reproduced | nothing yet; an audit never executes code | `reproduction: not-attempted` |
| A person confirmed the finding | `findings classify` | `disposition` |
| A person approved an issue proposal | `issues approve` | `approval` |

None implies the next. Confirming a finding creates no proposal and approves nothing. No model output can set any of them.

## Finding ledger

`conclave audit` (without `--no-write`) folds the run into `.conclave/findings/ledger.json`. Findings are keyed by the fingerprint the audit already assigns, so auditing the same code again never duplicates one.

| State | Meaning |
| --- | --- |
| `new` | First observed in the latest audit |
| `persistent` | Observed before and again in the latest audit |
| `resolved` | The latest audit examined its location with its rule and did not observe it, or a file it involves no longer exists |
| `reappeared` | Observed again after having been `resolved`; it keeps its id, first-seen run and classification |
| `not-evaluated` | Absent from the latest audit, which could not have observed it: its file was ignored, withheld for safety, unparseable or not examined by the rule, or the rule did not run |

A finding is resolved only on positive grounds. Ignoring a file, or a file being withheld because it now matches a credential detector, never resolves the findings in it.

Each entry records the first and last run that observed it, the run that last evaluated it, how many audits observed it, and its recent state changes. A run is identified by snapshot and time and links to the snapshot id and commit.

Human classifications are kept through every state change.

**Storage.** Plain JSON under the repository's `.conclave` directory, which ignores itself in Git and is skipped by audits. Writes go to a temporary file that is flushed and renamed over the target, under a lock shared by the CLI and the cockpit. The previous version is kept as `ledger.json.bak`; a ledger that no longer parses is read from it, and if neither parses the command fails instead of starting an empty ledger. A ledger written by a newer schema is refused and left untouched.

**Retention.** The 100 most recent runs are kept. A resolved finding that nobody classified is dropped 180 days after it was resolved. A finding a person classified is never dropped.

**Identity changes.** The ledger records its fingerprint scheme. A migration maps each stored entry to at most one current finding; two findings can never inherit the same history.

`--no-write` records nothing: no report, no ledger. Reading commands (`findings list`, `issues list`) create nothing in a repository that was never audited.

## Triage

`findings classify <id> --as <disposition> [--note TEXT]`

| Disposition | Meaning |
| --- | --- |
| `unreviewed` | Nobody decided yet (also resets a decision) |
| `confirmed` | A person judged it a real problem |
| `false-positive` | The rule matched and the code is correct; a note is required |
| `accepted-risk` | Real, and deliberately not being fixed; a note is required |
| `needs-investigation` | Someone should look further |

Classifications are appended to `.conclave/finding-feedback.jsonl`, the same log review feedback uses, with the time, who recorded it and the audit run. The ledger holds the current disposition; if the ledger is lost, the next audit restores dispositions from the log.

A disposition is independent of lifecycle state and of evidence. It does not change the audit report or its exit code.

## Baseline

A baseline lets findings that already exist stay visible without failing CI.

```sh
conclave audit . --update-baseline     # writes .conclave-baseline.json; commit it
conclave audit . --fail-on medium      # fails only on findings outside the baseline
conclave audit . --no-baseline         # ignore the baseline for this run
```

`.conclave-baseline.json` lists fingerprints, rule ids and paths. A baselined finding stays in the report, in the counts and in the ledger, marked `baseline`; only the exit code leaves it out. A baseline is not a classification: a baselined finding is still `unreviewed` until a person says otherwise, and it can still be proposed as an issue.

The baseline is written only by `--update-baseline`, which cannot be combined with `--no-write`.

## Applicability declarations

Some locations are wrong on purpose, such as parser fixtures. Test files are not excluded as a class; a repository declares the specific places instead, in `.conclave-audit.json`:

```json
{
  "schemaVersion": 1,
  "applicability": [
    {
      "paths": ["tests/fixtures/invalid/"],
      "rules": ["parser-diagnostic"],
      "role": "fixture",
      "reason": "Deliberately invalid input for the parser tests",
      "issueProposals": false,
      "gate": false
    }
  ]
}
```

| Field | Meaning |
| --- | --- |
| `paths` | Gitignore-style patterns. Negations and patterns covering the whole repository are rejected |
| `rules` | Optional. Limits the declaration to these rules |
| `role`, `reason` | Required. Shown wherever the finding is shown |
| `issueProposals` | Default `false`: no issue proposal can be drafted for it |
| `gate` | Default `true`: it still counts toward `--fail-on`. Set `false` to exempt it |

A covered finding is never hidden. It appears in the report with the declaration that matched (`applicability.source`), and `summary.exempt` counts the ones left out of the exit code. A finding that involves a file outside the declared paths is not covered. An invalid file fails the audit rather than being ignored.

## Issue proposals

`issues propose <finding-id>` drafts a proposal from fixed templates. No model writes it. The body states the rule and location, a table of what is and is not established, the rule's general guidance, limitations and provenance. It says outright that nothing was reproduced and that impact was not assessed, and it invents no reproduction steps or expected behavior. A finding no person confirmed is titled `[Unconfirmed]` and opens with an unconfirmed-hypothesis notice.

The body contains locations and rule statements, never source text. Text that came from the repository sits in code spans and fenced blocks, where Markdown, links and mentions are inert.

A proposal cannot be drafted for a finding that is resolved, not evaluated, suppressed inline, classified as a false positive, or declared ineligible.

### Lifecycle

```
draft → pending-review → approved → ready-for-publication
            ↘ rejected            ↘ stale → (refresh) → draft
```

| Command | Transition |
| --- | --- |
| `issues edit <id> [--title] [--body-file] [--label]...` | Changes the text. A material change makes a new revision |
| `issues submit <id>` | `draft → pending-review` |
| `issues approve <id> --revision REVISION` | `pending-review → approved`, for that exact revision |
| `issues ready <id>` | `approved → ready-for-publication`, only if every publication requirement holds |
| `issues reject <id> --reason TEXT` | `→ rejected` |
| `issues refresh <id>` | `stale → draft`, rebound to the finding as it is now |

**Approval is explicit and bound to a revision.** The revision is a digest of the title, body and labels. `approve` takes the revision the person read (at least 12 leading characters), or a typed confirmation at an interactive terminal; a script without either is refused. An approval names its revision, the evidence digest of each finding, who gave it, when and how.

**An approval does not survive what it did not cover.** A material edit returns the proposal to `pending-review` and moves the approval to `invalidatedApprovals`. Line endings, trailing whitespace and label order are not material.

**Stale.** After each audit and each classification, a proposal is marked `stale`, and its approval voided, when its finding was resolved, the source text behind the evidence changed, or the finding was reclassified. Code that only moved does not make a proposal stale. A stale proposal must be refreshed and reviewed again.

**Rejected.** A rejected proposal is not drafted again by later audits. `issues propose` on the same finding is refused unless a reason is given (`--reason`) or the source evidence changed since the rejection; the new proposal records what it supersedes. Proposing a finding that already has a live proposal returns that proposal.

### What a publisher must check

`ready-for-publication` is a convenience for people. The requirement is `publicationGate()` (`src/validation/issue-proposal.ts`), which a future publisher must call at publication time. It recomputes the revision from the text and compares it with the approval, compares each finding's current evidence digest with the one approved, and checks the finding is still observed, not a false positive, not suppressed and not declared ineligible, and that no text matches a credential detector. Editing the state file to say `approved` does not make a proposal publishable.

## Service and local API

`TriageService` (`src/workflow/triage-service.ts`) is the one implementation; the CLI and the cockpit's loopback server both call it.

| Method | Route |
| --- | --- |
| `listAuditRuns()` | `GET /api/audit/runs?projectId=` |
| `listFindings(filter)` | `GET /api/findings?projectId=&state=&disposition=&rule=&severity=&path=&baselined=&suppressed=` |
| `getFinding(id)`, `readFindingEvidence(id)` | `GET /api/findings/detail?projectId=&id=` |
| `classifyFinding(id, …)` | `POST /api/findings/classify` |
| `listProposals(filter)` | `GET /api/issues?projectId=&status=&findingId=` |
| `getProposal(id)` | `GET /api/issues/detail?projectId=&id=` |
| `createProposal(findingId, …)` | `POST /api/issues/propose` |
| `editProposal`, `submitProposal`, `approveProposal`, `rejectProposal`, `markProposalReady`, `refreshProposal` | `POST /api/issues/edit`, `submit`, `approve`, `reject`, `ready`, `refresh` |

Every `POST` passes the server's existing loopback-host, same-origin and JSON-content-type checks. `approve` requires the `revision` in the request body and never defaults it. There is no publication route.

## Limits

- Local state has no authentication. Anyone who can write the repository's `.conclave` directory can record a classification or an approval; the recorded name is informational. A publisher will need its own authorization.
- Secret detection is pattern based. It keeps recognized credential formats out of findings, proposals and notes; it does not prove a text is free of secrets.
- Repository identity is derived from the canonical local path. A moved or copied checkout keeps its ledger and records the former id.
- A finding's identity includes its flagged line. Editing that line resolves the old finding and creates a new one; its classification does not carry over.
