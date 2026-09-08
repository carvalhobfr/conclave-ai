# Validation report contract

The runner accepts schema v2 and v3. Conclave 0.9 emits schema v3, declared in `schemas/validation-report.v3.schema.json`. The unchanged v2 schema remains published for historical reports. V3 replaces dimension-level `evidenced`/`checked-clean` coverage with `partial`/`unchecked`, records each narrow rule and its applicability, and preserves remaining verification questions even when a finding exists. V2 report digests remain valid across rechecks. Neither schema establishes behavioral completion.

## Verdict and exit code

| Verdict | Exit | Interpretation |
| --- | ---: | --- |
| `pass` | 0 | No deterministic blocker or warning was found. This is bounded evidence, not a proof of all runtime behavior. |
| `warn` | 0 | The review completed, but one or more risks require attention. |
| `block` | 1 | A contradiction, scope violation, parser failure, or other deterministic blocker exists. |
| `inconclusive` | 2 | Available evidence cannot honestly prove the resolution. |

Runner errors use exit code 3 and do not constitute a Conclave verdict.

## Required interpretation

- `summary`: machine-produced executive result.
- `findings`: ordered evidence-backed risks. Prefer `blocking`, then `warning`, then `info`.
- `claims`: each declared completion claim is `supported`, `rejected`, or `inconclusive`.
- `impact`: changed symbols plus graph-reachable files and symbols, including unchanged consumers.
- `metrics`: bounded deterministic work performed; model calls are not implied.
- `trustBoundary`: exact reasoning-model and repository-script call counts, plus the parser, graph, and embedding strategy used to build validation knowledge.
- `changeSet`: exact comparison source and HEAD identity. The patch is represented by its byte count, not embedded in the report.
- `workspace` source: the merge-base-to-current-workspace comparison, including committed, staged, unstaged, and untracked files.
- `lineage`: stable series/review identity plus objective, contract, diff, artifact, previous-report, and report digests. `contractStatus` is `initial`, `preserved`, `strengthened`, or `rebaseline-required`. An invalid previous digest or a changed objective/contract cannot inherit trust silently.
- `findingLifecycle`: fingerprint-based finding history. `duplicate-recheck` means the diff did not change; `stagnant` means persistent findings survived the configured number of meaningful iterations; `regression` means a previously seen finding returned.
- `receipts`: externally produced check evidence classified as `current`, `stale`, `invalid`, `failed`, or `unbound`. Current worktree receipts must bind to the artifact or diff digest and include an output digest. Receipt trust is conservatively reported as self-reported.
- `challengePlan`: the always-on deterministic baseline followed by at most three risk-selected strategies and suggested probes. These are review directions, not claims that the probes ran.

Do not infer evidence that is absent from these fields. A `pass` means the implemented deterministic checks passed; it does not mean arbitrary runtime, UX, security, or business behavior was executed.
