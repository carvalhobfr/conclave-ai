# Browser smoke checks

Install optional `playwright` and Chromium (`npx playwright install chromium`). Start your local app, create a review and explicitly run:

```sh
conclave smoke . /tmp/report.json /tmp/browser-plan.json /tmp/browser-receipts.json
```

The command interacts with the declared local app. Ordinary review never launches a browser. A plan looks like:

```json
{
  "version": 1,
  "id": "preference-reload",
  "baseURL": "http://127.0.0.1:3000",
  "criterionIds": ["preference"],
  "steps": [
    {"action":"fill","selector":"#preference","value":"dark"},
    {"action":"click","selector":"#save"},
    {"action":"assert-text","selector":"#status","value":"Saved"},
    {"action":"reload"},
    {"action":"assert-value","selector":"#preference","value":"dark"}
  ]
}
```

Criterion IDs must exist in the review. The runner copies their exact digests into the receipt and checks the Git artifact before and after execution. Attach the receipt through the cockpit or `--receipt` on a recheck. Failures remain failures. A running server may still serve an old build: Git binding alone does not attest the deployed server, so browser receipts remain reported observations unless separately signed and verified.

Only loopback HTTP(S) targets are accepted. Browser requests, WebSockets and navigations stay on the configured origin. Contexts are fresh, with service workers blocked and no existing user profile. Plans require an assertion, allow at most 20 steps, limit each interaction to five seconds and the whole scenario to 90 seconds. Output records step results and a digest, not page contents or credentials. Assertions are scenario-specific; a successful save/reload check does not prove concurrency, authorization or accessibility.

The versioned Chromium fixtures cover three outcomes: persisted value, a success message without persisted data, and failed saving. The actual cockpit flow is also tested: save a criterion, reload it, review a real Git change and record finding feedback at 390 px width. Browser tests run separately via `npm run test:browser` and in the browser CI job.

Finding feedback is available in the Findings view. Confirmed problem, false positive and accepted risk require a note and an actual saved report/finding identity. Entries stay in `.conclave/finding-feedback.jsonl`; they never silently suppress or change a deterministic verdict.
