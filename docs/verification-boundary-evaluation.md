# Retrieval evidence and semantic verification — 2026-10-05

## Change

Model-authored checks previously promoted a text/graph lookup into a verdict about an entire natural-language claim. A repository-wide caller could reject a claim about a specific function. A matching expression could support an incorrect behavioral interpretation. A challenge retrieving new evidence could also reject a claim without proving a contradiction.

Retrieval now records its predicate result and evidence while leaving the claim uncertain. Uncertain checks proceed to the semantic verifier instead of being considered resolved. Those decisions remain model judgments, never deterministic behavioral proof. Investigator/verifier guidance now distinguishes scope, observable consequence and alternative implementations from textual presence. The scripted Demo was updated for the newly required verifier phase. No case names, expected bugs or answer keys were added to production prompts.

This conservatively adds semantic verification even for simple structural claims: the system has no trusted mapping that proves a model-authored predicate is equivalent to its prose. The zero-model `check` engine is unchanged. Additional latency/calls are a deliberate cost of this boundary.

## Validation

- Focused reasoning tests: 29 passed, including scope mismatch, source matches without behavioral proof, and extra challenge evidence without proven contradiction.
- Full suite initially: 345 passed, 4 skipped, one Demo failure because its fake provider had no semantic verifier response. After adapting the scripted Demo, all 5 tests in that affected file passed. Unaffected suite tests were not rerun solely to duplicate evidence.
- Typecheck, lint, core build, 11 web tests and diff whitespace checks passed.
- Conclave review against HEAD: PASS, zero blocking/warning findings. This is structural evidence only. It also included an existing local settings file outside this patch; that file was not edited.

## Real provider rerun

Same 20 synthetic hard repositories, same neutral tickets and external behavioral oracles; no hints or answer-key changes. All 20 baselines passed; all 14 defective candidates failed assertions; all 6 healthy candidates passed. Sixty actual provider reviews completed, using OpenCode Go / deepseek-v4.1-flash. No failed cell or retry was discarded. These are real executions over small synthetic modules, not production PRs or unseen holdout cases.

| Mode | Previous defect signals / 14 | Current defect signals / 14 | Previous → current false alarms on 6 controls | Median seconds before → after | Calls before → after |
|---|---:|---:|---:|---:|---:|
| Ask | 14 | 14, one partial/misexplained | 1 → 1 | 7.4 → 8.2 | 42 → 42 |
| Investigate free-like | 13 | 14 | 1 → 2 | 9.8 → 13.7 | 57 → 73 |
| Investigate full | 12 | 14 | 1 → 0 | 10.1 → 12.5 | 58 → 67 |

The counts measure localized target signals, including tentative ones, not the correctness of every statement. Ask/H12 identifies the shared array but incorrectly claims that it is frozen and mutation throws. A supplemental execution confirms shared mutable items and successful push. This is a partial signal, not a fully correct diagnosis. Zero false alarms on healthy controls also does not mean zero false claims in defective cases.

Only one stochastic run per case/configuration before and after; there is no statistical guarantee that the changes caused every observed difference. Ask's changed output also reflects generic investigator guidance and model variation. No competitor or direct single-model baseline was run.

### Observed improvements

- Full/H08 preserves the true missing-authorization diagnosis as uncertain instead of rejecting it on an unrelated caller. The new trace never turns retrieval predicates into semantic decisions.
- Both Investigate modes now surface the shared mutable array in H12.
- H16's false interpretation of nullish defaults disappeared in both Investigate outputs.
- Full/H18 recognizes that the cache holds the new value rather than alleging a stale read.

### Remaining failures

- Ask/H20 invents an inverted authorization condition; free-like/H20 calls the correct condition broken. External oracles show the owner is allowed and the intruder rejected.
- Free-like/H18 still suggests stale reads despite cache.set replacing the entry. The claim is uncertain, but it is still a false actionable signal.
- Both Investigate modes make a false extra claim in H06 that node:path join discards the root for an absolute second argument. A supplemental execution disproves it. The real encoded-traversal diagnosis remains correct.
- Generic concurrency concerns in H17 and malformed-encoding behavior in H19 remain separate from the oracle's target. They are not silently scored as defects or clean reviews.
- Some outputs still repeat causal claims and describe implementation details without reaching a useful decision. UI simplification is still outstanding.

## Assessment

The deterministic trust-boundary defect is fixed and regression-tested. The live rerun is encouraging for target detection in Investigate, but semantic reliability is not solved. In particular, free-like gained coverage while adding a false alarm. `supported` is still a model judgment. Do not position this patch as an overall accuracy win, a superior full tier, or approval of delivery behavior.

Next priority: distinguish predicate observations, semantic judgments and executed behavior in the result UI; then evaluate on unseen changes and a direct-model baseline before choosing default routing. Preserve uncertainty and contradictory evidence instead of adding case-specific rules.

## Local evidence

- Previous run: `.conclave/product-lab/run-kOH2u6/ai-7IdrXv/`.
- New run: `.conclave/product-lab/run-jiuFOl/ai-PzUBLp/`.
- Each contains experiment.json, original responses, HTTP traces, per-case metadata, comparison.json and adjudications.json with exact quotes/evidence IDs.
- New external oracles: `.conclave/product-lab/run-jiuFOl/oracles/`.
- Supplemental checks and adjudication script: `.conclave/product-lab/run-jiuFOl/adjudicate.mjs` and `supplemental-checks.json`.
- Implementation review: `.conclave/product-lab/run-jiuFOl/implementation-review.json`.

Artifacts stay local and ignored by Git. Adjudication was performed by Codex, not an independent human. No publication, commit or push was performed.
