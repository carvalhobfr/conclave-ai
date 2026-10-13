# Semantic discovery

`conclave audit [REPOSITORY] --semantic` adds a model to the repository audit. After the deterministic rules run, a model reads bounded regions of the indexed source and proposes behavioral defects that no rule describes: a wrong comparison, a fallback that hides a value, work that is not awaited, a cache that is not invalidated, an ownership check that is missing.

It is off by default. Without `--semantic` the audit calls no model and its report is unchanged.

Everything this stage produces is a **hypothesis**. Nothing is executed, so nothing is reproduced, and no hypothesis is a confirmed defect until a person classifies it.

## Pipeline

| Stage | Uses a model | What it does |
| --- | --- | --- |
| Mapping | No | The existing index: files, symbols, import and call graph, rule findings, coverage gaps |
| Discovery | Yes, the discovery model | One call per region. The model sees the region with line numbers, plus the code it calls and the code that calls it, taken from the graph |
| Evidence gate | No | Drops a hypothesis whose quoted line is not in the file, duplicates, and anything a rule already reported on the same line. Marks an invalid-input hypothesis with whether a call site was cited; it does not drop it |
| Verification | Yes, one verifier model | The default `smart` pipeline: one call per hypothesis to a model other than the discovery model, shown exactly what discovery was shown |
| Deep analysis (`--deep`) | Yes, the reasoning roles | Instead of the single verifier: the existing `ReasoningEngine` (Investigator, Skeptic, Architect, Verifier, Judge, chosen by its router) challenges each hypothesis |
| Triage | No | Surviving hypotheses enter the finding ledger as `ai-hypothesis`; classification and issue approval are the same human steps as for rule findings |

Discovery starts from the code. It does not need a rule match, and it is told which rule findings exist only so that it does not repeat them.

A region is one file, or part of a file larger than about 12 KB, cut at top-level symbols. Regions are ordered by how connected the file is in the graph, product code before tests and fixtures. The repository is never sent as one prompt.

The model may name up to three symbols whose definition it was not shown. If the index has them, the region is asked once more with those definitions. That is the only follow-up in discovery; the reasoning roles do their own retrieval during investigation.

## What is checked deterministically

**The quote.** The line a hypothesis quotes must exist in the region. The line number is taken from that match, not from the model. A hypothesis that quotes text that is not there is dropped and counted as `ungrounded`.

**Reachability of invalid input.** The model classifies each trigger as `normal-use` (a value or call sequence the code is evidently written for) or `invalid-input` (a caller would have to pass a wrong type, malformed text, NaN, a zero or negative size, an empty value). An `invalid-input` hypothesis is checked for a cited line, outside the function itself, that exists in the shown code and calls that function by name, and is recorded with the result in `hypothesis.reachability`:

| `reachability` | Meaning | What happens |
| --- | --- | --- |
| `call-site-cited` | The cited call site exists. It shows a caller exists, not that it passes the bad value | The call site becomes a second evidence location (`reachedBy`), and the verifier is told to reject the claim unless that call can really pass such a value |
| `unproven` | No such call site was cited | The hypothesis is **kept**, counted in `semantic.hypotheses.reachabilityUnproven`, and carries a limitation saying reachability is unproven. The verifier is told to answer uncertain, not rejected, when the code would misbehave on that value but nothing shown says whether it can arrive |

`unproven` is an absence of evidence. Callers outside the repository, or outside what the model was shown, are not ruled out, so a hypothesis is never discarded for this reason; it was not shown to be unreachable. A `normal-use` hypothesis has no `reachability` field.

These checks show a hypothesis points at real code and, for invalid input, whether a real caller was cited. They do not show the hypothesis is right, and the `normal-use` / `invalid-input` label itself is the model's.

## Review outcomes

| `hypothesis.review.status` | Meaning |
| --- | --- |
| `not-reviewed` | It was not verified (outside `--investigate`, or the budget ended) |
| `model-supported` | The verifier supported it; with `--deep`, the roles supported at least one claim and rejected none. A model judgement, not proof |
| `model-disputed` | The verifier (or, with `--deep`, the roles) rejected it. Kept, ranked last |
| `inconclusive` | The verifier could not decide, or the verification call failed; with `--deep`, the roles disagreed or stayed uncertain |

A verification that fails (provider error, output that cannot be validated after one repair) never counts as support or as rejection: the hypothesis is recorded as `inconclusive`, counted in `hypotheses.verificationFailed`, and verified again on the next run.

A hypothesis the verifier rejects is still recorded, as `model-disputed`. Repeating verification on the same 25 hypotheses four times showed a verifier changing its answer on about a quarter of them, and one model rejecting a true hypothesis in two of four runs. A rejection therefore lowers priority and removes nothing; only the deterministic gate removes, and it removes only ungrounded quotes, duplicates and what a rule already reported. Agreement between models is never treated as independent evidence, and no outcome sets `reproduction` or `humanConfirmation`.

## Models and routing

Provider configuration is the one `ask` and `investigate` use. Ollama, LM Studio and any OpenAI-compatible endpoint work as they do there.

| Task | Model |
| --- | --- |
| Mapping, filtering, quote check | None |
| Discovery (most calls) | `--discovery-model`, else `CONCLAVE_DISCOVERY_MODEL`, else the Investigator's model; always on the Investigator's provider |
| Verification (default) | `--verifier-model`, else `CONCLAVE_SEMANTIC_VERIFIER_MODEL`, else `CONCLAVE_VERIFIER_MODEL` |
| Deep analysis (`--deep`) | The role models: `CONCLAVE_INVESTIGATOR_MODEL`, `CONCLAVE_SKEPTIC_MODEL`, `CONCLAVE_ARCHITECT_MODEL`, `CONCLAVE_VERIFIER_MODEL`, `CONCLAVE_JUDGE_MODEL`; a System One judge such as Jev works here as it does for Investigate |

The default verifier is the Verifier role's model. When that is the discovery model, verification is a second reading by the same model: it is labelled `independent: false` and the report says so. Name another with `--verifier-model`. In the lab a verifier from another model family was not measurably better than the same model and was about ten times slower, so no pairing is applied automatically.

Before the first call the command prints the provider, the models, whether source leaves the machine, and the budget.

## Budget

| Option | Default | Limits |
| --- | ---: | --- |
| `--max-calls N` | 40 | Provider requests, failed and repaired ones included |
| `--max-input-tokens N` | 200000 | Approximate input tokens |
| `--max-output-tokens N` | 40000 | Approximate output tokens |
| `--max-minutes N` | 15 | Wall time; checked between calls, so one call can overrun it |
| `--max-regions N` | 30 | Regions sent to the discovery model in this run |
| `--investigate N` | 10 | Hypotheses verified (or, with `--deep`, challenged by the reasoning roles); `0` skips it |

Up to 40% of the call budget is held back for investigation, so reading more regions cannot starve it.

Token counts are estimated from bytes and reported as approximate. Counts the provider returned are reported beside them.

**Cost.** Conclave has no price list. `--price-input` and `--price-output` (US dollars per million tokens) make the report compute an amount from your numbers. Without them the cost is `not-priced`, or `local-inference` for a local provider, which means no per-token charge and says nothing about machine time.

## Coverage

`semantic.coverage` is separate from the rule coverage in `coverage`.

| State | Meaning |
| --- | --- |
| Indexed | `coverage.filesAnalyzed`: parsed and given to the rules |
| Examined by rules | `rules[].filesExamined` |
| `examined` | Sent to the discovery model in this run |
| `examined-cached` | Unchanged since a run that examined it with the same model; that result was reused |
| Investigated | `filesInvestigated`: holds a hypothesis the roles challenged |
| `not-examined-budget` | The budget ended first |
| `not-examined-failed` | The provider failed or returned output that could not be validated |
| `not-examined-withheld` | Matched a secret detector and could not be sanitized |
| Not eligible | Indexed files that are not source (JSON, Markdown, ...), and everything in `coverage.excluded` |

`complete: true` means every eligible region was examined. It never means the code is free of defects: a region with no hypothesis proves nothing.

**Resuming.** When the audit may write, results are cached in `.conclave/audits/semantic-cache.json`, keyed by a digest of the prompt and the model. An unchanged region costs no call next time, so running the same bounded audit again continues with the regions it did not reach. The cache holds model output and paths, not source.

## In the ledger

A hypothesis is a finding with `origin: "ai-hypothesis"`, `ruleId: "semantic-discovery"`, `status.ruleMatched: false` and a `hypothesis` record (model, confidence, trigger, consequence, review).

- It never counts toward `--fail-on` and is not in `summary`; see `semantic.hypotheses`.
- A later audit that does not report it leaves it `not-evaluated`. A model's silence is not evidence that a defect is gone, so only the file disappearing resolves it.
- An issue proposal drafted from it says a model proposed it, that no rule matched, and that nothing was reproduced. Approval is the same explicit human step. Nothing is published.
- `// conclave-ignore semantic-discovery` suppresses one, and `.conclave-audit.json` declarations and the baseline apply as they do to rule findings.

## Security

- Region and related source pass `ModelContextLedger` and every request passes `protectOutgoingMessages`; a request that cannot be sanitized is not sent.
- Files excluded from the index (credential names, credential content, ignored paths) are never read by this stage.
- Source is sent inside a block marked untrusted. Model output is validated against a schema, stripped of control characters and scanned for credentials before it is stored.
- Model output is text only. No command it writes is run, and it cannot set a disposition or approve a proposal.

## From the cockpit

**Repository audits** in the cockpit runs the same stage: **Smart** is `--semantic`, **Deep** is `--semantic --deep`. The page shows the provider host, the models, whether the verifier is independent and the budget before anything is sent, and the audit starts only after the person ticks the acknowledgement. The findings inbox shows `reachability`, the review outcome and the verifier's reasoning for each hypothesis. See [the cockpit guide](guides/cockpit.md#repository-audits-static-smart-and-deep).

## Measuring

`node scripts/product-lab-semantic.mjs run` audits every Product Lab case as a bare source tree (candidate and baseline), with no diff, ticket or label, and `score` compares the result with the changed lines and with a reader's adjudication. It makes real model calls. See the header of the script.
