# Review lineage and evidence receipts

Conclave keeps the finish line fixed while a developer or coding agent changes the code. A schema-v2 or schema-v3 report identifies the review series, exact artifact, contract, previous report, recurring findings, attached external evidence, and selected challenge strategies.

## Correction-loop protocol

Start with a concrete objective and, when useful, a contract:

```bash
conclave check . --base origin/main \
  --objective "Restore expired sessions without weakening authorization" \
  --contract .conclave/contract.json \
  --json > /tmp/conclave-1.json
```

After a correction, pass the prior report back unchanged:

```bash
conclave check . --base origin/main \
  --objective "Restore expired sessions without weakening authorization" \
  --contract .conclave/contract.json \
  --previous-report /tmp/conclave-1.json \
  --receipt /tmp/tests.json \
  --json > /tmp/conclave-2.json
```

`--series <id>` asserts the expected series ID. `--new-series` deliberately starts a fresh baseline and cannot be combined with `--previous-report`.

## Contract integrity

The lineage contains SHA-256 digests for the objective, normalized contract, diff, artifact, previous report, and current report. Contract comparison is structural:

- unchanged objective, claims, and scope: `preserved`;
- added claims only: `strengthened`;
- changed objective, removed or changed claims, changed allowed path prefixes, or invalid prior digest: `rebaseline-required`.

Rebaseline-required reports are `INCONCLUSIVE`. Conclave never silently weakens the quality bar or automatically accepts a semantic rewrite as progress.

## Finding lifecycle

Each finding has a stable fingerprint based on its kind, normalized detail, and evidence identity rather than volatile line numbers. Across a verified lineage, findings can be new, persistent, resolved, or regressed. The report-level progress is one of `initial`, `duplicate-recheck`, `progress`, `stagnant`, `regression`, or `mixed`.

An identical diff is a duplicate recheck and does not advance the stagnation counter. Stagnation means the same findings survived the configured number of changed-artifact iterations.

## Receipt format

A receipt is external evidence. Conclave validates its shape, artifact binding, freshness, and reported exit status; it does not execute the command and does not elevate a claimed trust level without cryptographic verification.

```json
{
  "version": 1,
  "receipts": [
    {
      "id": "unit-tests",
      "type": "test",
      "command": "npm test",
      "exitCode": 0,
      "startedAt": "2026-08-13T10:00:00.000Z",
      "finishedAt": "2026-08-13T10:01:00.000Z",
      "artifactDigest": "artifact_<64 lowercase hex characters>",
      "outputDigest": "<64 lowercase hex characters>",
      "runner": "local-shell",
      "trustLevel": "locally-observed",
      "summary": "126 tests passed"
    }
  ]
}
```

Types are `test`, `build`, `lint`, `typecheck`, `benchmark`, `runtime`, or `other`. A receipt is classified as `current`, `stale`, `failed`, `invalid`, or `unbound`. For `working`, `workspace`, and `staged` sources, `HEAD` alone is insufficient because local content can differ without changing the commit; the receipt must include the report's `artifactDigest` or `diffDigest`. A current receipt must also include the command, exit code, start and finish times, output digest, and runner. The schema-v2 report preserves those fields and adds a digest of the normalized receipt for auditing.

All current trust claims are effectively `self-reported`. Verified CI attestations and signed protected baselines are future hardening work, not implied by schema v2.

## Adaptive challenges

Every report keeps the deterministic baseline and adds at most three focused strategies selected from repository evidence: security, data integrity, lifecycle/state, public API compatibility, blast radius, performance, UX/accessibility, and test gap. The report gives a reason and suggested probes. Their presence means “challenge this risk,” not “these probes ran.”

## Schema v3 coverage and v2 compatibility

Conclave 0.9 emits schema v3. Risk dimensions use `partial` or `unchecked`; each lists `checks` with rule identity, `finding`/`no-finding`/`not-applicable` status, exact scope, source paths and finding IDs, plus `remainingQuestions`. No current rule verifies a full risk dimension. Further verification may require tests or human analysis; the escalation signal never launches a model or executes a repository script.

The v2 schema remains unchanged. CLI, history and skill readers accept v2/v3, and rechecking a v2 report validates its original digest without rewriting it. Legacy coverage is displayed with an explicit limitation. The report digest still covers all fields, including coverage. The criterion editor and verified CI provenance are later 0.9 milestones; receipts remain effectively self-reported.
