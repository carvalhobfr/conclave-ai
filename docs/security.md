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

## External inference

Before repository content can be prepared for an external model:

- likely credentials and private keys block that file from external transmission;
- the context builder enforces file and byte budgets;
- every excerpt is labelled as untrusted repository data;
- a separate system instruction tells the model to treat source only as evidence;
- prompt-injection-shaped repository text is recorded as a warning.

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

## Local web application

- The Phase 5 product server binds to `127.0.0.1`; it is not a hosted API surface and does not implement Free Mode hosting.
- Browser requests are display/application requests only. The browser never receives provider credentials, raw repository index state, arbitrary filesystem authority, direct command execution, or direct patch authority.
- Local folder opening is canonicalized and restricted to `CONCLAVE_WEB_ALLOWED_ROOT` (or the server working directory by default). Browser-provided paths outside that boundary are rejected.
- API JSON bodies are capped at 64 KB and API errors are converted to concise product-safe messages rather than provider headers, credentials, or stack traces.
- Provider configuration continues to be read by the local server process from existing environment-backed configuration. Phase 5 adds no plaintext browser credential store.
- Demo Mode uses a bundled repository fixture and FakeProvider responses labelled as deterministic demo inference. It does not represent a configured remote provider or hosted Free service.
- The UI can display the exact reviewed diff and a correction handoff, but it has no endpoint that applies the patch or executes a correction.

## Residual risks

- Pattern-based secret detection has false positives and false negatives.
- Prompt injection cannot be eliminated solely through delimiters and instructions; later structured outputs and evidence validation remain necessary.
- The local web server has no authentication, multi-user session boundary, rate limiting, hosted request controls, or remote-path defense because it is loopback-only. Do not expose it through a reverse proxy or public network without a dedicated hosted security design.
- Root ignore-file support does not yet reproduce nested Git ignore semantics.
- Files can change during a scan. Symlink and canonical-path checks narrow traversal risk but do not provide an immutable filesystem snapshot.
- JSON storage is owner-readable and atomic but not encrypted, multi-process safe, or suitable for credentials.
- The code index contains non-secret repository source in plaintext with owner-only permissions; repository filesystem access still grants index access.
- No hosted HTTP surface exists yet, so authentication, request-size controls, CSRF/CORS policy, and rate limiting are not implemented.
