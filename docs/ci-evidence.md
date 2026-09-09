# CI evidence and the Conclave Action

Use `carvalhobfr/conclave-ai@v0.11.0` after checkout (full history) and setup-node (Node 22). Supply `base`, `head` and `objective`; optional `contract`, `receipts` and `previous-report` are paths inside your checkout. The Action builds its pinned engine, runs structural review and writes a GitHub job summary. It does not run the reviewed repository's scripts. `report` and `verdict` are outputs. Upload the report with `actions/upload-artifact` for the next correction cycle.

An optional `comment-token` updates one marked comment for same-repository PRs. Leave it empty for job-summary-only output. Do not use `pull_request_target` to check out and execute untrusted PR code. Keep workflow concurrency keyed by PR to avoid simultaneous comment creation. Fork PRs do not receive comments from this Action.

## Collect execution results

Run `conclave collect REPOSITORY REPORT.json PLAN.json OUTPUT.json` explicitly. The plan contains `version: 1` and `checks`, each with `id`, `type`, `argv` (executable and arguments), `timeoutMs` (100–300000) and `criterionIds`. Only the supplied plan executes; ordinary review never invokes it. Executions are sequential, capped at 15 minutes in total and 1 MB output each. Timeout or excessive output fails the receipt. Output is hashed, not saved. Do not put credentials in command arguments. The runner uses your environment and can run arbitrary repository code; invoke it only for a plan you intend to execute.

The collector checks the reviewed Git artifact before and after execution and refuses evidence if source changes. Keep reports, plans and receipt outputs outside the reviewed tree (or in an ignored directory). Immutable reviews require a clean checkout at the reviewed commit. Receipt links copy the criterion digests from the report; unrelated tests cannot support every criterion.

## Verify CI provenance

Sign the resulting receipt file using GitHub's `actions/attest` with build provenance, then import it with:

```sh
conclave check . --attested-receipt receipts.json \
  --attestation-repository OWNER/REPO \
  --attestation-workflow OWNER/REPO/.github/workflows/ci.yml
```

Conclave calls `gh attestation verify` against a private snapshot of those bytes, enforcing the repository, exact signing workflow, source commit, SLSA provenance predicate and GitHub-hosted runner. A failed or missing verification stops the command. The caller must have GitHub CLI authentication and network access. JSON trust labels alone cannot grant verified status; reimporting an ordinary JSON receipt starts with reported provenance again. Valid cryptographic provenance establishes where the receipt came from, not whether its test is adequate. The cockpit's ordinary uploaded receipts remain self-reported.

Reference: [GitHub attestation verification](https://cli.github.com/manual/gh_attestation_verify) and [attestation action](https://github.com/actions/attest).
