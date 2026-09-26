# How Conclave review works

[English](how-it-works.md) · [Português (Brasil)](how-it-works.pt-BR.md) · [← README](../../README.md)

Review is deterministic code analysis, not a chat completion. No source is sent to a model and no API key is needed.

<p align="center"><img src="https://raw.githubusercontent.com/carvalhobfr/conclave-ai/master/docs/assets/conclave-review-pipeline.svg" alt="Git comparison goes through a local structural index, impact graph, checks and an evidence-backed verdict" width="900"></p>

1. **Git** supplies the exact comparison and patch.
2. **Local parsers** identify files and code units: named functions, methods, classes, interfaces, and modules.
3. **A relationship graph** follows imports, exports, calls, references, containers, and consumers.
4. **Deterministic checks** challenge scope, public code changed without changed tests, parser-visible errors, impact outside the diff, deletions, and optional completion claims. They also report defects visible in the changed text: a resource acquired but never released, an error swallowed by an empty `catch`, and a store addressed by a literal where the same file uses a named constant.
5. **A verdict** (`PASS`, `WARN`, `BLOCK`, or `INCONCLUSIVE`) with file-and-line evidence where available.

This is useful evidence, not a compiler, test runner, security scanner, runtime proof, or automatic approval. A human remains the merge authority.

## Supported languages

| Language | Functions/classes | Imports | Graph impact | Test-file detection |
| --- | ---: | ---: | ---: | ---: |
| TypeScript / JavaScript / TSX / JSX | Yes | Yes | Yes | Yes |
| Python | Yes | Yes | Yes | Yes |
| Java | Yes | Yes | Yes | Yes |

Other text languages still appear in the Git change and scope evidence, without the same graph depth. See the [roadmap](../../ROADMAP.md).

## Coverage and when a model is worth it

Each report says which narrow rules examined the change and which questions remain open. A finding, or the lack of one, never verifies a whole risk area.

| Coverage | Meaning |
| --- | --- |
| `partial` | Applicable rules examined only their declared scope. Read `checks` and `remainingQuestions`. |
| `unchecked` | No applicable deterministic rule examined this area in the available source. |

`escalation.recommended` means more verification is warranted: relevant tests, human review, or optional model reasoning (`conclave investigate`). It never starts a model or runs repository scripts by itself, and a model cannot replace runtime evidence.

```bash
conclave check . --json | jq '.report.escalation'
```

## Verdicts

| Verdict | Meaning | Next action |
| --- | --- | --- |
| `PASS` | No deterministic blocker or warning found | Run relevant tests and request human review |
| `WARN` | Reviewable risk remains | Inspect or correct it, then recheck |
| `BLOCK` | Evidence contradicts scope, claims, or structural safety | Send the handoff to a coding agent, then recheck |
| `INCONCLUSIVE` | Available evidence cannot support a safe conclusion | Improve the base, objective, contract, or parser evidence |

A comparison with no changed files reports "Nothing to review", not a failure.

## What Conclave never does

Review is read-only: it does not edit source, execute scripts, commit, push, approve, or merge. Saving criteria and feedback writes local review metadata only. The separate `collect` and `smoke` commands run a bounded plan only when you invoke them. See [security boundaries](../security.md).

## Reference

- [Review lineage and receipts](../review-lineage.md)
- [Acceptance criteria](../acceptance.md) · [CI evidence](../ci-evidence.md) · [Browser smoke](../browser-smoke.md)
- Report schema: [v5](../../schemas/validation-report.v5.schema.json) (older versions in [`schemas/`](../../schemas))
