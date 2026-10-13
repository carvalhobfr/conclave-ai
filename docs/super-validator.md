# Super-validator design

SuperValidator is the independent evidence checkpoint behind `conclave review` and `conclave validate`. It is one step in the broader Conclave workflow: the context and agent features help investigate or implement a change, while SuperValidator checks the resulting Git change and emits a report with evidence and a verdict for an agent, CI job, or human to use.

This is a pre-merge evidence layer, not a full code-quality or runtime judge. It does not compile the repository, run its test suite, execute the application, or infer product intent. `PASS` means that the available deterministic checks found no blocker; it does not guarantee that the implementation is correct in every environment. The next workflow step is to use the evidence with tests, runtime checks, optional model reasoning, security review, and human approval.

The index is built locally from safe repository files. It contains file metadata, supported-language structural units, imports, exports, calls, inheritance, deterministic local embeddings, and graph edges. A review does not ask a model whether the change looks correct; it checks whether the repository can support the claims made about that change.

## Product invariant

Conclave validates a resolution independently of the actor that produced it.

A model statement is never completion evidence. A successful model call is never a passing check. Timeout, missing evidence, ambiguous graph resolution, and unsupported analysis must remain visible and can never be silently converted to success.

## Inputs

A validation run has three required inputs and two optional protocol inputs:

- a Git change source: working tree, staged index, an explicit base/head branch range, or a checked-out commit;
- an objective describing the behavior the resolution is meant to deliver;
- a validation contract containing scope and deterministic completion claims (an empty contract is valid);
- an optional previous schema-v2 report for lineage and contract comparison; and
- optional external evidence receipts bound to the reviewed artifact.

The collected patch remains local in the deterministic gate. Reports expose patch byte size, changed files, hunks, and evidence, but not the complete patch. Snapshot alignment is mandatory: untracked files are never silently omitted from working/staged validation, staged validation rejects unstaged contamination, and an explicit branch base/head is materialized from Git so the current checkout and untracked files cannot contaminate the comparison.

## Project and impact graph

The current repository index supplies file and code-unit nodes plus typed relations. In the report schema, a code unit is called a `symbol`: a named declaration such as a function, class, method, interface, enum, or component.

- symbol ownership and containment;
- imports and exports;
- references and calls;
- inheritance and implementation.

Changed line ranges are mapped to current symbols. Validation starts from changed files and symbols, then traverses a bounded graph to identify unchanged consumers and contracts outside the diff.

Missing edges mean unresolved static knowledge, not proof that no runtime relation exists.

## Validation contract

The contract is Conclave's concrete quality bar. It must describe facts that can be checked against actual artifacts.

```ts
interface ValidationContract {
  objective: string;
  allowedPathPrefixes: readonly string[];
  claims: readonly ValidationClaim[];
}
```

Claims use typed checks instead of free-form model agreement. A contradicted claim blocks. A claim whose target cannot be resolved is inconclusive. Text claims search the supported TypeScript/JavaScript/Python/Java source index; non-source artifacts and languages without deep parsers should be asserted with file-level checks.

## Challenge order

1. Git and scope invariants.
2. Parser and index health.
3. Changed-symbol mapping.
4. Graph impact outside the diff.
5. Public/exported behavior and test evidence.
6. Deterministic completion claims.
7. Deterministically select the baseline plus at most three risk-specific challenge strategies.

Deterministic findings must be preserved if a later semantic pass fails or times out.

The schema-v2 `trustBoundary` records the work actually used to reach a validation verdict: the syntax-aware parser and graph, deterministic local feature-hash embeddings, zero reasoning-model calls, zero remote embedding calls, and no repository-script execution. Configured remote embeddings remain outside this validation gate. Receipt trust claims do not alter that boundary: externally reported checks are never described as executed by Conclave.

## Review lineage

Every report contains a digest-bound lineage envelope. Rechecks can supply the previous report so Conclave can verify its digest, preserve the review series, compare the objective and contract structurally, and classify recurring findings. A semantic objective change, removed or changed claim, changed allowed scope, or invalid previous digest produces `rebaseline-required` and an `INCONCLUSIVE` result. Added claims strengthen the existing contract.

Finding fingerprints omit volatile line positions and numeric counters, and are unique within a report: single-location findings are anchored to their enclosing symbol and flagged line, so two defects of one kind in one file are tracked separately. The lifecycle distinguishes identical reruns, meaningful progress, persistent stagnation, and regressions. Duplicate diffs do not advance the stagnation counter.

See [review-lineage.md](review-lineage.md) for the CLI protocol and receipt format.

## Verdict semantics

- `PASS`: all available required checks support the resolution.
- `WARN`: no contradiction, but evidence identifies reviewable risk.
- `BLOCK`: deterministic evidence contradicts the resolution or its allowed scope.
- `INCONCLUSIVE`: the system lacks enough trustworthy evidence to decide.

The semantic difference between `WARN` and `INCONCLUSIVE` is proof availability. Warning means known risk; inconclusive means the required fact could not be established.

## Gauntlet Loop influence

The design is informed by [robonuggets/gauntlet-loop](https://github.com/robonuggets/gauntlet-loop), licensed CC BY 4.0 and credited to Jay E / RoboNuggets, with the underlying technique credited there to Matt Shumer.

Conclave uses the ideas of a real comparison bar, independent harsh criticism, actual-output inspection, and a single largest remaining gap. It does not copy the prompt and does not adopt unbounded iteration.

For code validation:

| Gauntlet Loop | Conclave |
| --- | --- |
| Named, fetchable bar | Objective, contract, tests, base behavior, repository invariants |
| Separate builder and critic | Writer-independent validator |
| Blind A/B comparison | Base/head and claim/evidence comparison |
| Biggest remaining gap | Highest-severity actionable finding |
| Loop until ours wins | Bounded challenge; unresolved work is inconclusive |

## Next hardening steps

1. Index both base and head so removed symbols and call paths are first-class evidence.
2. Add type-checker and `tsconfig` resolution.
3. Add permissioned, sandboxed local check execution and verifiable output capture.
4. Verify CI attestations and signed reports at protected trust boundaries.
5. Add redacted, bounded semantic challenges with fresh context.
6. Measure finding precision, false positives, wall time, model usage, and termination reason on real PRs.
