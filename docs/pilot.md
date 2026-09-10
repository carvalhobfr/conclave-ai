# Pilot readiness and measured limits

Conclave 0.13 completes the initial engineering sequence: scoped rule coverage, confirmed acceptance criteria, explicit execution receipts, verified GitHub provenance, browser persistence scenarios and local feedback. Commercial viability and behavior outside the tested scenarios remain unproven.

## Reproduce the engineering checks

From the source checkout:

```sh
npm ci
npm run verify
npx playwright install chromium
npm run test:browser
npm run eval:product
npm run eval:package
```

`eval:package` installs the packed artifact in an isolated directory, checks package contents and CLI startup, saves a criterion, executes a real fixture, rechecks with evidence and verifies that later source changes invalidate the receipt. GitHub CI runs this installed-package flow on Linux, Windows and macOS with Node 20 and 22. Browser fixtures run separately on Chromium/Linux. Read the run status before treating a platform as validated.

## Measured fixture results — 2026-09-09

The version-1 corpus contains 11 small synthetic source scenarios. It produced 5 true positives, 1 false positive and 1 false negative: precision 5/6 and recall 5/6 (both about 83%). These are measurements of this small corpus, not accuracy claims for real PRs. The two known limitations remain in the results rather than being removed to improve the score:

- Same receiver/handler text across distinct scopes can hide different runtime objects.
- Cleanup delegated to another module may be reported as missing because its execution cannot be inferred by a file-local rule.

The local source-rule evaluation took about 7 ms, and the full installed-package acceptance fixture took about 7.4 seconds on macOS/Node 22 in this run. These figures are observations on synthetic inputs; package cache and machine load affect them. They do not establish end-user latency. Machine-readable results are written under `.conclave/` and uploaded by CI.

Chromium fixtures distinguish successful persistence, a success message without persistence, and a failed save. The cockpit scenario exercises creating and confirming a criterion, saving, reloading, reviewing a real changed file and recording feedback at 390 px width. These tests passed locally and in the browser CI workflow for 0.12.

## First real pilot

Recruit 3–5 small teams using coding agents and collect at least 50 real PR reviews with explicit permission. These are targets, not completed recruitment or usage. No customer messages, billing or hosted accounts are created by this release.

For each pilot:

1. Install the released package and run `conclave open .` in a real repository.
2. Confirm the objective and acceptance criteria before reviewing the delivery.
3. Review the change; inspect findings and still-open questions.
4. Execute appropriate checks deliberately. Attach their receipts and recheck the same series.
5. Record confirmed problems, false positives and accepted risks with a reason.
6. Record elapsed time to useful feedback, review duration, correction cycles, known missed problems and whether the team uses the tool again without prompting.
7. Interview the responsible engineering lead about usefulness and willingness to pay. A proposed price is a hypothesis until supported by these conversations.

Keep repository contents and local feedback on the team's machine unless they explicitly authorize sharing. Do not count npm downloads as users, findings as incidents prevented, or accepted suggestions as independently validated defects.

## Release 0.14 gate

Publish measured pilot results, limitations, onboarding observations and the resulting commercial scope only after real usage exists. This gate is external to engineering implementation. The 0.14 pilot release remains pending; publishing an empty milestone would not satisfy it.

## Publication state

Git commits and version tags are published per minor after validation. npm requires the maintainer's one-time authentication code in the current release session; prepared tarballs do not mean the registry has been updated. Confirm registry versions after authentication before advertising an npm release.
