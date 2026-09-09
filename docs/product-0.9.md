# Conclave 0.9 and beyond — delivery evidence

## Product and audience

Help small engineering teams using coding agents decide what needs correction, what still needs verification, and what changed since the last attempt. The initial buyer hypothesis is a technical founder or engineering lead. Validate it with 3–5 pilot teams and at least 50 real PRs; these are recruitment targets, not existing traction.

The product promise is traceable delivery evidence: requested outcome → confirmed criteria → reviewed change → supporting or contradicting evidence → correction → recheck → human decision. Structural findings, reported execution results, verified execution provenance, and human judgments remain distinct.

## Release sequence

Ship each accepted product increment as a separate minor version. After its validation gates pass, publish the version to npm and push its commit and version tag to master. Publication of each minor is authorized; authentication requirements still apply. A completed engineering milestone is not proof of market demand.

| Version | Deliverable | Acceptance gate | Status |
| --- | --- | --- | --- |
| 0.9.0 | Honest rule coverage and a decision-first report | Exact rule scope and open questions visible in JSON, CLI, handoff and cockpit; historical v2 reports readable; focused failure cases covered | Implemented; validation gates passed |
| 0.10.0 | Criteria and correction workflow | Create and confirm stable criteria without writing JSON; link implementation, checks and receipts; show supported, contradicted, not verified and human decision states; retain criteria across rechecks and detect drift | Implemented |
| 0.11.0 | CI evidence and PR distribution | Reusable official Action; import test/build results bound to the reviewed artifact; distinguish reported from verified provenance; one updated PR summary and correction comparison | Implemented; real CI attestation verified |
| 0.12.0 | Behavioral evidence and feedback | Opt-in bounded smoke plans; detect failed saves and lost persistence; local finding feedback; versioned fixtures and measured failure cases | Implemented |
| 0.13.0 | Pilot readiness | Installation/package/OS checks; end-to-end acceptance flow; documented latency, precision, misses and limitations; pilot onboarding | Planned |
| 0.14.0 | Pilot release | All engineering gates pass; publish measured results and known gaps; decide commercial scope using actual pilot feedback | Planned |

## 0.9 scope and acceptance

1. No selected risk dimension is represented as fully verified by a narrow heuristic. Report the rules considered, their applicability, observed findings and remaining questions. A finding never closes unrelated questions in the same dimension.
2. Source-only rules identify their JavaScript/TypeScript boundary. Unsupported or unavailable source is not a clean check. No-change reviews do not invent verification work.
3. Resource cleanup detection cannot be satisfied by an unrelated release elsewhere. Any candidate association is explicitly syntactic and does not prove that teardown executes.
4. The first result screen presents next action, findings requiring attention, missing evidence, and correction progress. PASS means no deterministic blocker or warning, not completion of the objective. Structural claims are never labelled behavioral proof.
5. JSON schema v3 declares the coverage change. Existing schema v2 remains published unchanged; v2 reports remain readable and comparable with their original digest. Legacy coverage is displayed with an explicit limitation.
6. CLI summaries and agent handoffs retain the same open questions as the cockpit. Model recommendations remain advisory; no model calls or repository scripts are executed by review.
7. Regression cases exercise partial coverage, finding-plus-open-question, unsupported languages, cleanup decoys, missing/failed/stale receipts, legacy reports, no-change and rechecks. Run typecheck, lint, build, core/web tests, existing evaluations, packaging and Conclave review. Record visual QA separately.

## 0.10 design constraints

- Criteria have stable IDs, user-confirmed statements and explicit verification plans. Automatically proposed criteria remain proposals until confirmed.
- Existence of a function or string can support a structural assertion only. It never proves a behavior such as persisting a preference after reload.
- Receipt-to-criterion links are explicit. A successful build or unrelated test does not verify every criterion. Provenance and adequacy are separate axes.
- Missing, stale, invalid, unbound or self-reported evidence cannot silently promote a criterion to verified. Contradictions and human decisions remain visible.
- Rechecks retain criteria, objective and scope; changed expectations require an explicit baseline decision. Show progress per criterion separately from finding lifecycle.
- The criteria editor, saved contracts, CLI, API, report schema, handoff and cockpit ship together with end-to-end fixtures.

## Evaluation and commercial experiment

Maintain versioned defect cases with expected outcomes, including negative cases and known misses. Measure actionable-finding precision and recall on labelled cases; measure pilot feedback separately because accepted suggestions are not ground truth. Record time to first useful review, review duration, repeat weekly usage, correction cycles and willingness to pay. Do not claim incidents prevented from finding counts.

Keep the local engine open. Test shared history, team policy and CI evidence as paid collaboration features only after pilots establish value. €49–99 per team/month is an interview hypothesis, not an approved price or forecast. Hosted collaboration needs a separate storage/access/security design. More model adapters follow demonstrated pilot needs.

## Deferred scope

Always-on model councils, broad provider expansion, automatic code mutation, automatic merge/deploy, billing and hosted account systems are outside the initial release. Runtime collection uses a separately scoped, opt-in runner; the review engine stays read-only. Recruitment, customer outreach and paid provider calls are outside implementation scope.

## 0.9 validation record — 2026-09-08

- Full verification: typecheck, lint, production build, 285 core tests, 6 web tests, existing retrieval/graph/release evaluations and production dependency audit passed (0 vulnerabilities reported).
- Browser QA used the real working-tree review, not the demo: next action, verification gaps, rule details, diff and handoff were reachable. Tested the default desktop viewport and 390 × 844; after fixing the repository header wrapping, the mobile document width equalled the viewport width (390 px). No browser console errors were observed.
- The current schema-v3 report was checked against the declared field constraints; portable runners accept v2/v3. Regression tests cover preservation of a v2 digest and retention of both versions through history writes.
- `deterministicChecks` now counts executed check scopes, including checks without findings; it is not a behavioral coverage percentage. Source cleanup matching is syntactic and file-local; aliases, delegated cleanup and actual lifetime remain verification questions.
- Self-review: Conclave returned PASS on the implementation comparison with no deterministic findings. The model also read the changed code; this is additional fallible review, not independent runtime proof or merge approval. Product-level criteria and pilot value remain unproven and belong to subsequent milestones.

Next implementation: 0.10's criteria editor and stable contract persistence, shipped with CLI/API/report/handoff integration and a recheck that shows per-criterion progress. Do not begin hosted billing or expand providers before this flow is usable.

## Release policy and 0.9 validation — 2026-09-08

The initial alpha increment is released as 0.9.0 with the same bounded scope. Criteria, CI evidence, behavioral checks and pilot readiness have separate minor versions above. The release verification passed again with 285 core tests, 6 web tests, typecheck, lint, builds, evaluations and zero production dependency vulnerabilities. Browser observations above are from the earlier implementation session; this release pass did not repeat visual QA.

0.11 live provenance validation: GitHub Actions run 34370350177 generated and verified a real CLI-startup receipt with current binding and ci-verified provenance. This proves the attestation path, not comprehensive CLI behavior.
