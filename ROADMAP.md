# Conclave roadmap

Conclave is a read-only PR companion. The product gathers context and evidence, a coding agent or developer corrects the code, and a human decides whether it can merge. Autonomous code mutation is intentionally outside this roadmap.

## 0.3 — Natural review workflow

- `conclave check` as the recommended zero-ceremony entry point.
- Workspace comparison that includes branch commits, staged, unstaged, and untracked files.
- Automatic base detection and transparent fallback objective.
- `conclave setup` for agent and GitHub integration.
- `conclave doctor` for repository readiness.
- Clear “Nothing to review” state instead of a blocking false failure.

## 0.4 — Universal code review

- One multi-language review path for TypeScript, JavaScript, Python, and Java.
- Language-aware production/test file checks.
- Richer PR summary and exact changed-file evidence.
- Repository-language-independent GitHub workflow.
- PR comment, annotations, job summary, report artifact, and deterministic gate.

## 0.5 — Agent correction loop

- Primary Codex and Claude Code skill.
- Transient `npx` fallback: the skill can run without adding the package to the target repository.
- Portable correction handoff generated from findings and evidence.
- Full local reports and handoffs in review history.
- Explicit loop: review → agent correction → recheck → human approval.

## 0.6 — Review cockpit

- `conclave open .` launches the local UI and opens the selected repository automatically.
- Workspace/base selector with repository branch metadata.
- Summary, findings, claims, affected code, exact diff, raw report, and copyable handoff.
- Shared CLI/UI local review history.
- Read-only interface boundary; no patch application, repository scripts, commits, pushes, approvals, or merges.

## 0.7 — Trustworthy correction protocol — implemented

- Digest-bound review lineage across correction-loop rechecks.
- Contract drift detection: changed objectives, claims, or allowed scope require an explicit rebaseline instead of silently moving the finish line.
- Stable finding fingerprints and lifecycle states for duplicate rechecks, progress, stagnation, and regression.
- External evidence receipts bound to the exact artifact or diff, with stale, failed, invalid, and unbound states.
- Deterministic risk routing: the baseline plus at most three focused challenge strategies.
- Agent protocol through `--previous-report`, repeatable `--receipt`, `--series`, `--new-series`, and schema-v2 JSON.
- Correction handoffs that expose lineage, progress, receipts, selected challenges, and rebaseline requirements.

## 0.8 — Local review and escalation — implemented

- Zero-model-call source checks and deterministic escalation signals.
- Local CLI, cockpit, portable skills, correction lineage and GitHub workflow.
- Existing coverage is structural and heuristic; it is not proof of delivery behavior.

## 0.9 — Delivery evidence — in progress

The active product sequence is [Conclave 0.9](docs/product-0.9.md): honest coverage and a decision-first report, confirmed acceptance criteria, CI-bound evidence, behavioral evidence, then pilot evaluation. The first increment is `0.9.0`; later increments remain planned until their acceptance gates pass. Provider expansion follows demonstrated user needs.

## Longer-term capability backlog

The capability descriptions below are retained as a backlog, not the current delivery order. The 0.9 product plan above takes priority. They are planned, not implemented. Existing provider types, environment-driven local runtime paths, or partial adapters do not satisfy a milestone by themselves. All designs remain clean-room; evidence collection remains explicitly scoped and review authority remains read-only.

### Milestone 1 — Local-first provider experience — planned

- **Problem:** Local and OpenAI-compatible runtimes exist behind manual configuration, while the guided setup exposes only a subset of providers and does not help users discover or verify local models.
- **Scope:** Introduce one declarative registry for providers and capabilities. Keep runtime/provider identity separate from model family: Ollama is a runtime/provider for models such as Llama, Qwen, DeepSeek, and Gemma; xAI is the provider for the Grok family. Add OpenAI, Anthropic, Google Gemini, xAI (Grok), OpenRouter, Ollama, LM Studio, and generic OpenAI-compatible endpoints to `conclave init`. Configure Ollama and LM Studio without API keys, probe local service availability, discover installed Ollama models, support interactive and flag-based model selection, improve `conclave models` and `conclave provider-check`, and document a 100% local and free quickstart.
- **Verifiable completion:** Every listed provider can be selected interactively and non-interactively and produces a redacted, schema-validated configuration. A running Ollama instance returns its installed models and accepts a selected model; an offline instance and an absent model produce distinct actionable diagnostics. LM Studio and Ollama setup never request or persist a real credential. Local endpoints remain restricted to loopback addresses. Setup distinguishes configuration success from an inference adapter verified in Milestone 2.
- **Tests and evidence:** Registry completeness and uniqueness tests; CLI snapshots for every provider and flag path; mocked online, offline, empty-model-list, and missing-model local services; an integration receipt from a loopback Ollama instance; documentation command checks for the local quickstart; secret-redaction and non-loopback rejection tests.
- **Risks and safety limits:** Model catalogs and aliases drift, local daemons can expose sensitive prompts, and endpoint input can become an SSRF path. Discovery is explicit, bounded, redacted, and loopback-only for local profiles; it must not download models or contact external endpoints without user action.
- **Dependencies:** Builds on the existing runtime configuration and OpenAI-compatible path. The registry is the source of truth for Milestones 2 and 3; full Gemini and xAI inference depends on Milestone 2.
- **Out of scope:** Automatic model downloads, background daemon installation, remote Ollama under a local profile, a package per model family, provider ranking, and any repository mutation.

### Milestone 2 — Complete provider adapters — planned

- **Problem:** A provider name or setup option is misleading when inference is unimplemented, protocol differences are implicit, or failures collapse into generic network errors.
- **Scope:** Implement and test the native Google Gemini adapter. Add an xAI/Grok preset over the OpenAI-compatible protocol. Reuse the OpenAI-compatible adapter for xAI, Ollama, LM Studio, OpenRouter, and custom compatible endpoints where their behavior permits it; retain native adapters only for materially different protocols. Declare structured output, embeddings, model discovery, credential requirement, local/external boundary, and token-parameter behavior as registry capabilities. Diagnose missing credentials, offline daemons, unknown models, incompatible structured output, and invalid endpoints separately.
- **Verifiable completion:** Each setup option is backed by a working adapter or an explicit unsupported-capability result. Contract tests prove request translation, response parsing, token accounting, timeouts, error redaction, and the declared capability matrix. Gemini completes native text and structured-output fixtures; the xAI preset completes the same compatible-adapter fixtures without a bespoke model package.
- **Tests and evidence:** Provider-independent conformance suite; Gemini protocol fixtures; OpenAI-compatible fixtures for xAI, Ollama, LM Studio, OpenRouter, and a custom endpoint; negative tests for every diagnostic class; live opt-in smoke receipts for external providers with credentials supplied outside logs and CI artifacts.
- **Risks and safety limits:** Provider APIs and model-specific token fields drift, “compatible” APIs differ at the edges, and error payloads can leak credentials. Capability claims stay versioned and test-backed, external smoke checks remain opt-in, secrets are never printed, and insecure HTTP is limited to approved loopback profiles.
- **Dependencies:** Requires the Milestone 1 registry. Milestone 3 may assign a provider only after this milestone proves its required capabilities.
- **Out of scope:** Training or hosting models, model-family-specific packages, automatic credential creation, silently falling back to another provider, and claiming feature parity from a type or preset alone.

### Milestone 3 — Multi-provider reasoning — planned

- **Problem:** The CLI constructs a runtime with one provider, so roles cannot use different local and cloud providers in the same review and the resulting report cannot describe real cross-provider participation.
- **Scope:** Allow multiple providers in one configuration and register every selected provider in the runtime. Separate provider configuration from role assignment so, for example, investigator can use Ollama, architect Anthropic, verifier OpenAI, and judge xAI/Grok. Preserve the simple single-provider default. Record the provider and model used for each participating role in the report and trust boundary.
- **Verifiable completion:** Interactive and flag-based configuration can add, edit, remove, and assign multiple providers without duplicating credentials. A mixed-provider fixture routes every role to its declared provider, while an unchanged single-provider configuration retains current behavior. Reports identify actual participants and do not treat model agreement as deterministic evidence.
- **Tests and evidence:** Configuration migration and round-trip tests; role-routing unit tests; mixed local/cloud integration fixtures; unavailable-provider and partial-role-failure tests; schema, CLI, handoff, and cockpit snapshots showing provider/model participation; a regression test proving that unanimous model output cannot override contradictory deterministic evidence.
- **Risks and safety limits:** Multi-provider runs increase cost, data exposure, latency, and configuration ambiguity. Before execution, Conclave shows which roles can make external calls; provider-specific budgets and the existing read-only boundary remain enforceable; no provider receives repository context outside its assigned call.
- **Dependencies:** Requires the Milestone 1 registry and the relevant verified adapters from Milestone 2. It supplies the routing and participation record used by Milestone 5.
- **Out of scope:** Mandatory councils, automatic provider selection by popularity, provider agreement as proof, shared credential services, and autonomous correction, commit, push, merge, or deploy.

### Milestone 4 — Acceptance evidence graph — planned

- **Problem:** Change impact, claims, findings, and receipts are individually available, but there is no complete graph showing whether each objective or contract criterion is supported by the changed implementation and its evidence.
- **Scope:** Link the objective and each contract criterion to changed files, changed code units, impacted consumers, tests, receipts, findings, and evidence. Classify every criterion as `verified`, `broken`, `not verified`, or `human decision needed`; missing evidence never becomes `verified`. Integrate the graph into the validation report, correction handoff, CLI, and cockpit with explicit schema versioning and compatibility behavior.
- **Verifiable completion:** Every criterion has a stable identity, status, rationale, and traceable graph edges. Contradictory deterministic evidence produces `broken`; absent or stale evidence produces `not verified`; genuinely subjective or conflicting evidence produces `human decision needed`. Serializers, older report readers, CLI, handoff, and cockpit render the same status without silently promoting it.
- **Tests and evidence:** Ground-truth contracts covering all four statuses; graph-edge tests from criteria through consumers and tests; stale, failed, invalid, and unbound receipt fixtures; schema validation and migration tests; CLI, handoff, and cockpit snapshots; regression tests that incomplete evidence cannot yield PASS through a criterion default.
- **Risks and safety limits:** A graph can imply more certainty than its inputs warrant, and schema changes can invalidate correction lineage. Every edge records its evidence source and confidence class; deterministic evidence remains distinct from model interpretation; incompatible schema changes require an explicit version boundary or rebaseline.
- **Dependencies:** Builds on the implemented schema-v2 lineage, receipts, finding lifecycle, deterministic impact graph, and challenge routing. Runtime evidence from Milestone 6 can add receipts later without changing the status semantics.
- **Out of scope:** Inferring undocumented business intent, executing tests merely because they are linked, converting human decisions into automatic PASS, and editing code to satisfy a criterion.

### Milestone 5 — Selective cross-provider challenge — planned

- **Problem:** Potentially harmful model-derived judgments such as BLOCK or critical findings deserve targeted scrutiny, but a full council on every review would add cost without making model agreement deterministic.
- **Scope:** Offer an optional second opinion for harmful model-derived judgments only. Route the challenge to a configured independent provider, cap cost, calls, and rounds, and record every participant in the trust boundary. When providers disagree, downgrade the affected judgment to INCONCLUSIVE or `human decision needed`. Conclusive deterministic findings remain authoritative.
- **Verifiable completion:** Eligible and ineligible judgments are selected by deterministic policy; the feature is off or single-provider by default; configured limits stop further calls; disagreement cannot remain a model-derived BLOCK or become PASS; deterministic blockers are neither voted away nor sent through an unnecessary council; reports show the challenged claim, responses, cost/call counters, and resulting status.
- **Tests and evidence:** Fixtures for agreement, disagreement, timeout, unavailable challenger, budget exhaustion, malformed response, deterministic blocker, and non-harmful finding; routing and trust-boundary snapshots; cost/call/round limit tests; evaluation receipts comparing runs with and without selective challenge.
- **Risks and safety limits:** Correlated models can create false confidence, challenges expose context to another provider, and retries can multiply cost. The UI and CLI disclose the additional external boundary before execution, require explicit enablement, and never describe consensus as deterministic proof.
- **Dependencies:** Requires Milestone 3 routing and participation records. Criterion-level downgrades integrate with Milestone 4 when available, while report-level INCONCLUSIVE remains the safe fallback.
- **Out of scope:** An always-on council, majority voting as truth, unbounded debate, automatic provider purchasing, overriding deterministic evidence, and autonomous correction or merge decisions.

### Milestone 6 — Runtime and visual evidence — planned

- **Problem:** Static evidence can miss an application that renders convincingly while interactions fail, requests error, state never commits, or saved data disappears after reload.
- **Scope:** Add safe, local, explicitly permissioned smoke-check execution. Collect application load, console errors, failed requests, allowlisted interactions, state changes, and persistence after reload. Keep screenshots and browser observations as evidence separate from model interpretation, detect optimistic-only saves and visually ready but behaviorally broken flows, and bind results through evidence receipts.
- **Verifiable completion:** No runtime command runs without explicit scope and permission. A smoke plan declares its command, origin, interactions, timeout, and forbidden actions; captured artifacts bind to the reviewed change. Fixtures detect load failure, console and request errors, inert controls, successful state change, optimistic-only save, and lost state after reload. Reports distinguish raw browser/screenshot evidence from any model-authored interpretation.
- **Tests and evidence:** Sandboxed runner tests for timeout, process cleanup, output limits, origin restrictions, and denied actions; browser fixtures for every evidence class; receipt binding, staleness, and artifact-integrity tests; screenshots plus structured network/console/state logs; end-to-end CLI, handoff, and cockpit rendering tests.
- **Risks and safety limits:** Browser automation can trigger irreversible side effects, execute untrusted repository scripts, leak secrets, or reach external systems. Execution is local, least-privilege, time-bounded, and opt-in; interactions and origins are allowlisted; payments, deletion, deployment, credential submission, destructive administration, and equivalent dangerous actions are never executed automatically.
- **Dependencies:** Uses the implemented receipt protocol and the Milestone 4 evidence graph. It may use provider interpretation from Milestones 2–3, but raw evidence collection and status remain independently inspectable.
- **Out of scope:** General autonomous browsing, production environment testing, pixel-perfect design approval, payment or destructive-flow testing, deploys, and any implicit permission to run repository scripts.

### Milestone 7 — Evaluation and proof — planned

- **Problem:** New capability and accuracy claims are not trustworthy without reproducible ground truth, failure cases, and cost measurements.
- **Scope:** Create versioned fixtures with known defects for every new capability. Measure false positives, false negatives, supported-claim precision, unsupported claim rate, regression detection, and cost/calls per review. Cover unavailable providers, absent local models, Gemini/Grok/Ollama paths, provider disagreement, a polished UI with a broken backend, and data that disappears after reload.
- **Verifiable completion:** Each metric has a documented denominator, fixture provenance, repeatable command, baseline result, and regression threshold. Results include environment and provider/model identities and separate deterministic, runtime, and model-derived evidence. Release or marketing claims cite a reproducible evaluation artifact; no claim that Conclave is “better” is made without comparable published results.
- **Tests and evidence:** Hermetic deterministic fixtures; opt-in recorded provider fixtures with freshness labels; seeded browser applications for broken-backend and reload-persistence cases; evaluator self-tests; machine-readable and human-readable reports; repeated-run variance and cost/call summaries in CI-safe artifacts.
- **Risks and safety limits:** Fixture overfitting, provider drift, selective reporting, and non-reproducible external calls can distort results. Keep failures in the report, version fixtures and prompts, label stale recordings, disclose exclusions, and never place live credentials or proprietary third-party material in evaluation artifacts.
- **Dependencies:** Evaluates Milestones 1–6 and can add a baseline alongside each milestone rather than delaying all measurement until the end. Cross-provider and browser metrics require Milestones 5 and 6 respectively.
- **Out of scope:** Benchmark claims without comparable conditions, copied competitor fixtures or proprietary architecture, hidden leaderboards, and treating model consensus or screenshots alone as proof.

### Later candidates — not scheduled

- deeper semantic resolution for Python and Java;
- Go, Rust, C#, Kotlin, and PHP structural parsers;
- a reusable first-party GitHub Action release and GitLab/Bitbucket adapters;
- SARIF and GitHub Checks output;
- configurable team policy files and protected baselines;
- richer large-repository graph summaries and incremental review performance;
- CI-verified and signed receipt/report attestations;
- optional hosted collaboration, only after a dedicated security design.
