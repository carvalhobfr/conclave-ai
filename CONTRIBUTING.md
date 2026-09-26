# Contributing

Keep changes small, evidence-backed, and covered by deterministic tests. Conclave is a read-only reviewer: do not add repository mutation, patch application, merge, or autonomous task execution to its public surfaces.

Before opening a change, run `npm run verify`. New retrieval, reasoning, and validation fixtures must declare their expected outcomes before evaluation. Never add credentials, generated `.conclave` state, or machine-specific paths.

Add user-visible changes to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md). Move them into a dated version section only when that version is actually published.

## Releasing

Releases publish from GitHub Actions through npm trusted publishing; no npm token is stored anywhere.

```bash
npm run release:bump -- patch "Changelog line in English" "Linha do changelog em português"
git commit -am "fix: … (x.y.z)"
npm run release:tag      # tags vX.Y.Z and pushes; .github/workflows/publish.yml verifies, publishes, and creates the GitHub release
```

`release:bump` accepts `patch`, `minor`, `major`, or an exact version, and keeps every pinned `conclave-ai@x.y.z` reference in sync.
