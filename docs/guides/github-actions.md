# Conclave on GitHub Actions

[English](github-actions.md) · [Português (Brasil)](github-actions.pt-BR.md) · [← README](../../README.md)

Review every pull request automatically with the same engine as the [CLI](cli.md).

## Add the workflow

```bash
conclave setup . --agents none --github-actions
```

This writes `.github/workflows/conclave-review.yml`. Commit it and open a pull request.

## What each run does

- checks out the pull request and compares its real base and head refs;
- runs a pinned Conclave version, with no `npm ci` or project build, so it works for any language;
- writes the job summary and file annotations;
- keeps one pull-request comment up to date;
- uploads the JSON report as an artifact; and
- fails only on `BLOCK` or `INCONCLUSIVE`.

Pull requests from forks still get the summary and artifact when GitHub withholds comment permission.

## Going further

- [CI evidence](../ci-evidence.md): attach test and build results as verified receipts.
- [Acceptance](../acceptance.md): check each run against saved criteria.
- Composite action: [`action.yml`](../../action.yml).
