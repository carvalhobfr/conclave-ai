# Security boundaries

Repositories are sensitive and their contents are untrusted. Phase 1 establishes the following enforceable boundaries.

## Credentials

- Provider credentials are read from process environment variables through `CredentialSource`.
- Serializable runtime configuration stores only the environment-variable reference.
- Credentials are held in a private field inside the HTTP adapter and are only placed in the outbound authorization header.
- Provider URLs containing usernames or passwords are rejected.
- External provider endpoints must use HTTPS.
- The JSON app-state store is not a credential store.

The loopback web backend keeps provider creation and credential access server-side.

## Repository paths

- Roots are canonicalized and must be accessible directories.
- Hosted callers can configure `allowedRoots`; paths outside them are rejected.
- Repository-relative paths come from filesystem enumeration, not user-provided retrieval paths.
- Symlinks are not followed.
- Canonical file paths are checked against the repository root before reads.
- Storage namespaces and keys reject traversal characters.

## Ingestion exclusions

Built-in exclusions cover version-control metadata, common dependency/build/cache directories, source maps, minified JavaScript, environment files, private-key files, and common credential filenames. Root `.gitignore` and `.conclaveignore` add repository-specific rules.

Files over the configured byte limit, repositories over the configured file limit, and likely binary files are not loaded.

## Coverage gaps

An excluded file is not an analyzed file. Every entry the loader skips is recorded with its reason, and every file the indexer leaves out is recorded as a coverage gap on the index: `safety-excluded-path` (the name matches a built-in credential pattern; the file is never read), `safety-excluded-content` (a credential or private-key detector matched; the file is read locally and never parsed, embedded, persisted or sent to a model), `ignored`, `unsupported-language`, `parser-failure`, `binary`, `oversized`, `symlink` and `unreadable`.

A validation report carries a `coverage` section that accounts for every changed file as analyzed, deleted or not analyzed with its reason, and counts exclusions across the repository. A changed file withheld for safety, changed source that could not be parsed, and changed source that is absent from the index for any other reason each produce a `coverage-gap` warning, so the verdict is never `pass` while one of them went unexamined. The CLI prints the same gap on its own line. Changed files of a type without a parser (documentation, configuration, assets) are listed in `coverage.gaps` without a warning, because no rule applies to them. `conclave scan` and `conclave index` list the safety-excluded paths.

A gap states that analysis did not happen. It is not a finding about the file: a safety exclusion is never reported as a vulnerability, and a detector match may be a placeholder or a test fixture. Gaps carry a path, a reason code and, for content exclusions, the detector category. They never carry a line, an excerpt or the matched value.

Source outside the change that is withheld for safety is invisible to the graph, so impact through its imports and calls is not reported. The coverage section lists those files and the CLI says how many there are.

## External inference

Before repository content can be prepared for an external model:

- likely credentials and private keys block that file from external transmission;
- the context builder enforces file and byte budgets;
- every excerpt is labelled as untrusted repository data;
- a separate system instruction tells the model to treat source only as evidence;
- prompt-injection-shaped repository text is recorded as a warning.

### Outgoing model context

Everything repository-controlled that is sent to a model crosses one boundary (`src/security/model-context.ts`):

- Diff hunks are sanitized when they are collected, before truncation, including removed lines. A credential deleted by a change is still in the diff.
- Every excerpt and hunk is sanitized again when a prompt is built, with the path recorded.
- The complete request is scanned once more in the agent runtime immediately before the provider call. Every entry point (CLI, cockpit, MCP, library) builds requests through that runtime.
- Remote embedding input and MCP evidence excerpts pass the same redaction.

Recognized secrets are replaced by `[REDACTED:credential]` or `[REDACTED:private-key]`; the rest of the text is kept. A unit that still matches a detector after redaction, such as a private-key header with no footer, is replaced whole by a fixed marker. A request that cannot be sanitized is not sent, and the role fails instead. A reasoning result carries `contextProtection` (paths and categories, never values) and the CLI prints it as a coverage limitation: the model reasoned without that content.

This is pattern detection, not a guarantee. It recognizes AWS key ids, GitHub, Slack, Google and `sk-`/`rk-`/`pk-` style tokens, JWTs, bearer and basic authorization values, passwords in URLs, private-key blocks and assignments to names such as `password`, `api_key` or `client_secret`. A secret in another format, a short or low-entropy password, a secret split across lines or built at run time, and a secret in a file name or symbol name are not detected. Model output is not scanned. Provider error text is redacted only for Conclave's own API key. Do not treat Ask or Investigate as safe for a repository whose history holds live credentials; rotate them.

The provider adapter never accepts a repository snapshot directly. A caller must explicitly build a bounded context from selected files. This prevents an accidental whole-repository request at the type/API boundary.

## Code indexing and retrieval

- Ignored files never reach the Phase 2 index because indexing consumes the Phase 1 repository snapshot.
- Any file with a blocking content-safety finding is excluded from parsing, lexical indexing, embeddings, graph construction, and persistence.
- Parser operations create syntax trees only. They do not type-check, import, evaluate, install, or execute repository code.
- Index paths are canonicalized beneath the repository root. Persisted file/unit paths must be normalized repository-relative paths.
- Index schema, repository ownership, unit/file ownership, and embedding dimensions are validated when loading.
- `.conclave/code-index-v2.json` is written atomically with owner-only permissions and is ignored by repository loading and Git. Indexing version changes invalidate older parser output and trigger a rebuild.
- Graph operations traverse only validated indexed nodes and edges and enforce bounded depth/node/result limits.
- Context packing reconstructs ranges only from the validated canonical source copy, verifies evidence content hashes, and enforces evidence, source-byte, and approximate-token budgets.
- Retrieval observability records event type, counts, paths, and ranks where needed. It does not record queries, complete private files, credentials, or hidden model reasoning.
- Evidence provenance comes only from deterministic index metadata and source ranges. No model can create or alter it.

## Local Mode

Local Mode is marked `local-only`, accepts only loopback HTTP(S) provider endpoints, and does not require a credential. Repository content can remain on the machine. Code retrieval uses the local deterministic feature-hash provider and persisted vectors without network access.

## Reasoning

- Repository excerpts are serialized only inside explicit untrusted-data sections; system role instructions and trusted task records are separate messages/sections.
- Roles return strict JSON. Unknown fields and fabricated claim, evidence, or graph-edge IDs are rejected before domain state changes.
- Agents can request only typed, bounded operations through `CodeRetrievalService`; they cannot open arbitrary paths, invoke tools, change providers, or expand budgets.
- Provider/model assignments come from validated host configuration, never repository text or model output.
- Deterministic verification overrides model agreement, and rejected claims are excluded by deterministic answer synthesis.
- Execution traces retain concise structured conclusions and usage metadata. They do not store hidden chain-of-thought.
- Reasoning is capped by model-call, round, repeated-request, evidence, graph, approximate-token, and output-token limits.

## Read-only product boundary

Conclave review does not edit source files, apply patches, execute repository scripts, commit, push, approve, or merge. Criteria and feedback endpoints persist local review metadata. Separate explicitly invoked collect/smoke CLI commands execute their bounded plans; there is no web endpoint for command or browser-plan execution. Review collects Git data and builds deterministic structural evidence. Ask and Investigate can call a configured reasoning provider, but their outputs cannot enter a mutation or shell path. Correction belongs to the developer's coding agent; approval belongs to a human.

## Executed command environment

`conclave collect` runs the commands of an explicit plan. The CLI loads provider credentials into its own environment at startup, so those commands do not inherit it. Each command starts from an empty environment and receives only an allowlist of variables needed to start local tools: `PATH`, `HOME`, the temporary-directory, locale and terminal variables, `CI`, `JAVA_HOME`, `VIRTUAL_ENV`, the `XDG_*` base directories, and the Windows system variables. No `CONCLAVE_*` value, provider key or other shell secret is passed.

`--forward-env NAME` passes one more variable by name, at most ten per run. Only the person running the command can request this: a plan file and a repository `.env` cannot. Conclave's own credentials (`CONCLAVE_*` names containing `KEY`, `TOKEN`, `SECRET`, `PASSWORD` or `CREDENTIAL`) are refused even when named. The receipt records the forwarded names, never their values.

Environment scrubbing is not a sandbox. A plan command runs as the current user with that user's filesystem, network and process access. It can read Conclave's per-user `credentials.env`, a project `.env`, cloud CLI configuration, SSH keys and any other file the user can read, and it can send data anywhere. Run a plan only when you would run its commands yourself, and run untrusted code in a container, virtual machine or disposable CI runner.

The browser launched by `conclave smoke` and the `gh` and `npm` helpers Conclave invokes for attestation and updates still receive the full environment.

## Local web application

- The Phase 5 product server binds to `127.0.0.1`; it is not a hosted API surface and does not implement Free Mode hosting.
- Browser requests are display/application requests only. The browser never receives provider credentials, raw repository index state, arbitrary filesystem authority, direct command execution, or direct patch authority.
- Local folder opening is canonicalized and restricted to `CONCLAVE_WEB_ALLOWED_ROOT` (or the server working directory by default). Browser-provided paths outside that boundary are rejected.
- API JSON bodies are capped at 64 KB and API errors are converted to concise product-safe messages rather than provider headers, credentials, or stack traces.
- Provider configuration continues to be read by the local server process from existing environment-backed configuration. Phase 5 adds no plaintext browser credential store.
- Demo Mode uses a bundled repository fixture and FakeProvider responses labelled as deterministic demo inference. It does not represent a configured remote provider or hosted Free service.
- The UI can display the exact reviewed diff and a correction handoff, but it has no endpoint that applies the patch or executes a correction.
- Every request, reads included, must name a loopback `Host` (`127.0.0.1`, `[::1]` or `localhost`); anything else is answered `403`, which closes a DNS-rebinding read. Every `POST` must also carry an `Origin` equal to that host and a JSON content type, so a page on another site cannot drive the server with a preflight-free form post.
- **Audit jobs.** `POST /api/audit/start` runs the audit the CLI runs. A `static` audit calls no model. A `smart` or `deep` audit is refused unless the request carries `acknowledgedModelCalls: true`, the literal boolean; a missing field, `false`, `"true"` or `1` starts nothing and reaches no provider. The cockpit withdraws the tick whenever the mode, a budget field or a model name changes, and after every start.
- **Disclosure before consent.** `GET /api/audit/preflight` returns the provider host, provider and model identifiers, whether source leaves the machine, and the budget. It reads configuration, calls no model, and never returns a credential; a configuration error names variables and providers, not values.
- **Budgets are caps, not estimates.** A semantic audit stops at the call, region, verification and time limits it was started with. Conclave holds no price list and does not predict cost.
- **Job status carries no source.** Progress lines name the stage and the region being read (`path:lines`); a failure message is truncated to 500 characters. Neither includes request bodies or credentials.
- **Evidence excerpts.** `GET /api/findings/detail` returns up to a bounded number of lines around a finding. Paths are confined to the repository lexically and after resolving links; symbolic links, credential file names, files matching a content detector and oversized files are withheld with a stated reason.
- **Repository and model text is displayed, never interpreted.** The cockpit renders finding text, source excerpts, model explanations and proposal bodies as plain text. Markdown in a proposal body is shown as source and is not rendered, so markup or links planted in a repository or returned by a model stay inert.
- **No model-generated action.** Model output is validated text. Nothing a model writes is executed, and no endpoint lets a model classify a finding or approve a proposal; those are `POST`s a person triggers.
- **Approval is one explicit action on one revision.** `POST /api/issues/approve` requires the revision the person was shown and never defaults it. Editing the text, reclassifying the finding, or a change to the source behind it voids the approval; a stale proposal cannot be approved or marked ready until it is refreshed and reviewed again.
- **Nothing is published.** There is no publication route and no GitHub call; `POST /api/issues/publish` answers `unknown_action`.

## Findings, triage and issue proposals

`conclave findings` and `conclave issues` keep local state under `.conclave` and make no model call, network request or GitHub call. See [finding-workflow.md](finding-workflow.md).

- **Proposals carry no source text.** A generated body holds locations and rule statements. Finding text that quotes the source (a storage key, a parser message) has recognized credential formats replaced by a category marker when the audit builds the finding, before it is saved, shown or drafted; text that still matches a detector is withheld whole. Text a person types (edits, notes, reasons) is refused, not rewritten, when it matches a detector.
- **Repository content is data.** Finding ids are hashes; nothing from the repository is used as a command, an option or an approval. Repository-derived text in a proposal body sits in code spans and fenced blocks, where Markdown, links and mentions are inert, and control characters are removed from finding text.
- **Paths stay inside the repository.** Source excerpts are read only from paths that resolve inside the repository, lexically and after following links. Credential file names and files matching a content detector are withheld. State directories that are symbolic links are refused.
- **Approval is not a flag.** An approval names the exact revision and evidence digests it covers. `publicationGate()` recomputes both from the proposal text and the ledger, so changing a stored `status` does not make a proposal publishable.
- **Policy files cannot hide findings.** `.conclave-baseline.json` and `.conclave-audit.json` are parsed strictly, reject unknown fields, and only annotate. Declarations covering the whole repository are rejected, and an invalid file fails the audit.

## Semantic discovery

`conclave audit --semantic`, and the cockpit's Smart and Deep modes that run it, are the only audit paths that call a model, and only when asked. The CLI prints the provider, models and budget first; the cockpit shows the same disclosure and requires an explicit acknowledgement (see [Local web application](#local-web-application)). Outgoing source crosses the same boundary as Ask and Investigate. Its output is a hypothesis: it is never executed, never gates an exit code, and cannot classify a finding or approve a proposal. See [semantic-discovery.md](semantic-discovery.md).

## Residual risks

- Pattern-based secret detection has false positives and false negatives.
- Prompt injection cannot be eliminated solely through delimiters and instructions; later structured outputs and evidence validation remain necessary.
- The local web server has no authentication, multi-user session boundary, rate limiting, hosted request controls, or remote-path defense because it is loopback-only. Do not expose it through a reverse proxy or public network without a dedicated hosted security design.
- Root ignore-file support does not yet reproduce nested Git ignore semantics.
- Files can change during a scan. Symlink and canonical-path checks narrow traversal risk but do not provide an immutable filesystem snapshot.
- JSON storage is owner-readable and atomic but not encrypted, multi-process safe, or suitable for credentials.
- The code index contains non-secret repository source in plaintext with owner-only permissions; repository filesystem access still grants index access.
- No hosted HTTP surface exists yet, so authentication, request-size controls, CSRF/CORS policy, and rate limiting are not implemented.
- The cockpit's consent tick records nothing: it gates one request. Anyone who can reach the loopback port from the local machine with a valid `Origin` can start a semantic audit with the configured provider key.
- Sanitization of source sent to a model is pattern based. The disclosure says so; it is not a guarantee that no secret leaves the machine.
