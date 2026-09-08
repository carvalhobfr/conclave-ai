import { createHash } from "node:crypto";

import type {
  GraphEdge,
  GraphNodeReference,
  IndexedCodeUnit,
  RepositoryCodeIndex,
} from "../domain/code-index.js";
import type {
  ChangeSet,
  ValidationChangedFile,
  ValidationClaim,
  ValidationClaimResult,
  ValidationContract,
  ValidationEvidence,
  ValidationFinding,
  ValidationFindingKind,
  ValidationFindingSeverity,
  ValidationReport,
  ValidationVerdict,
  EvidenceReceiptInput,
} from "../domain/validation.js";
import { createChallengePlan } from "./challenge-router.js";
import { assessEscalation } from "./escalation.js";
import { evaluateEvidenceReceipts } from "./evidence-receipts.js";
import { evaluateCriteria } from "./acceptance-criteria.js";
import { analyzeSourceDefects } from "./source-defects.js";
import {
  createFindingLifecycle,
  createValidationLineage,
  finalizeReportDigest,
} from "./review-lineage.js";

function stableId(kind: string, ...parts: readonly string[]): string {
  return kind + "_" + createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20);
}

function nodeKey(node: GraphNodeReference): string {
  return node.kind + ":" + node.id;
}

function isSourceFile(path: string): boolean {
  return /\.(?:[cm]?[jt]sx?|pyw?|java)$/iu.test(path);
}

function isTestFile(path: string): boolean {
  return /(^|\/)(?:tests?|__tests__|src\/test)(?:\/|$)|\.(?:test|spec)\.[cm]?[jt]sx?$|(^|\/)(?:test_.*|.*_test)\.py$|(?:Test|Tests|TestCase)\.java$/iu.test(path);
}

function pathMatchesPrefix(path: string, prefix: string): boolean {
  const normalized = prefix.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
  return path === normalized || path.startsWith(normalized + "/");
}

function intersectsChangedLines(unit: IndexedCodeUnit, file: ValidationChangedFile): boolean {
  if (file.status === "added" || file.hunks.length === 0) return file.status !== "deleted";
  return file.hunks.some((hunk) => {
    if (hunk.newCount === 0) return false;
    const end = hunk.newStart + hunk.newCount - 1;
    return unit.startLine <= end && unit.endLine >= hunk.newStart;
  });
}

function isDeletionOnly(file: ValidationChangedFile): boolean {
  return file.status === "deleted" || (
    file.hunks.length > 0 && file.hunks.every((hunk) => hunk.newCount === 0)
  );
}

function evidenceForUnit(unit: IndexedCodeUnit, reason: string): ValidationEvidence {
  return {
    path: unit.path,
    startLine: unit.startLine,
    endLine: unit.endLine,
    symbol: unit.symbol,
    reason,
  };
}

function evidenceForEdge(edge: GraphEdge): ValidationEvidence {
  return {
    path: edge.provenance.path,
    ...(edge.provenance.line === undefined ? {} : { startLine: edge.provenance.line }),
    ...(edge.provenance.endLine === undefined ? {} : { endLine: edge.provenance.endLine }),
    relation: edge.relation,
    reason: edge.provenance.reason,
  };
}

function finding(
  kind: ValidationFindingKind,
  severity: ValidationFindingSeverity,
  title: string,
  detail: string,
  remediation: string,
  evidence: readonly ValidationEvidence[] = [],
  fingerprintKey?: string,
): ValidationFinding {
  const evidenceIdentity = evidence.map((item) => [
    item.path,
    item.symbol ?? "",
    item.relation ?? "",
    item.reason,
  ].join(":"));
  const fingerprint = stableId(
    "fingerprint",
    kind,
    title,
    fingerprintKey ?? detail.replace(/\b\d+\b/gu, "#"),
    ...evidenceIdentity,
  );
  return {
    id: stableId("finding", kind, title, ...evidence.map((item) => item.path + ":" + (item.symbol ?? ""))),
    fingerprint,
    kind,
    severity,
    title,
    detail,
    evidence,
    remediation,
  };
}

function unitPath(
  index: RepositoryCodeIndex,
  node: GraphNodeReference,
): string | undefined {
  return node.kind === "file" ? node.id : index.units[node.id]?.path;
}

function impactFrom(
  index: RepositoryCodeIndex,
  startingKeys: ReadonlySet<string>,
  maxDepth: number,
): {
  readonly nodeKeys: ReadonlySet<string>;
  readonly edges: readonly GraphEdge[];
} {
  const visited = new Set(startingKeys);
  let frontier = new Set(startingKeys);
  const selectedEdges = new Map<string, GraphEdge>();
  for (let depth = 0; depth < maxDepth && frontier.size > 0; depth += 1) {
    const next = new Set<string>();
    for (const edge of index.graphEdges) {
      const from = nodeKey(edge.from);
      const to = nodeKey(edge.to);
      if (!frontier.has(from) && !frontier.has(to)) continue;
      selectedEdges.set(edge.id, edge);
      if (!visited.has(from)) next.add(from);
      if (!visited.has(to)) next.add(to);
    }
    for (const key of next) visited.add(key);
    frontier = next;
  }
  return { nodeKeys: visited, edges: [...selectedEdges.values()] };
}

function symbolUnits(index: RepositoryCodeIndex, symbol: string): readonly IndexedCodeUnit[] {
  return Object.values(index.units).filter((unit) => unit.symbol === symbol);
}

function lineForText(source: string, text: string): number {
  const lines = source.split("\n");
  const index = lines.findIndex((line) => line.includes(text));
  return index < 0 ? 1 : index + 1;
}

function claimResult(
  index: RepositoryCodeIndex,
  changedPaths: ReadonlySet<string>,
  claim: ValidationClaim,
): ValidationClaimResult {
  const expectationMatches = (present: boolean): boolean =>
    claim.check.expectation === (present ? "present" : "absent");

  switch (claim.check.kind) {
    case "symbol-exists": {
      const units = symbolUnits(index, claim.check.symbol);
      const present = units.length > 0;
      return {
        claim,
        outcome: expectationMatches(present) ? "supported" : "rejected",
        explanation: present
          ? "The indexed project contains the claimed symbol."
          : "The indexed project does not contain the claimed symbol.",
        evidence: units.slice(0, 10).map((unit) => evidenceForUnit(unit, "Indexed symbol evidence")),
      };
    }
    case "callers":
    case "references": {
      const units = symbolUnits(index, claim.check.symbol);
      if (units.length !== 1) {
        return {
          claim,
          outcome: "inconclusive",
          explanation: units.length === 0
            ? "The target symbol is not available in the current project index."
            : "The target symbol resolves to multiple declarations in the current project index.",
          evidence: units.slice(0, 10).map((unit) =>
            evidenceForUnit(unit, "Ambiguous target symbol declaration"),
          ),
        };
      }
      const target = units[0];
      if (target === undefined) {
        throw new Error("Expected a unique target symbol after validation");
      }
      const relations = claim.check.kind === "callers"
        ? new Set(["calls-symbol"])
        : new Set(["references-symbol", "calls-symbol"]);
      const edges = index.graphEdges.filter(
        (edge) =>
          relations.has(edge.relation) &&
          edge.to.kind === "symbol" &&
          edge.to.id === target.id,
      );
      const present = edges.length > 0;
      return {
        claim,
        outcome: expectationMatches(present) ? "supported" : "rejected",
        explanation: present
          ? "The project graph contains matching " + claim.check.kind + "."
          : "The project graph contains no matching " + claim.check.kind + ".",
        evidence: edges.slice(0, 10).map(evidenceForEdge),
      };
    }
    case "text": {
      const text = claim.check.text;
      const matches = Object.values(index.files).filter((file) => file.sourceText.includes(text));
      const present = matches.length > 0;
      return {
        claim,
        outcome: expectationMatches(present) ? "supported" : "rejected",
        explanation: present
          ? "The exact text exists in indexed source."
          : "The exact text does not exist in indexed source.",
        evidence: matches.slice(0, 10).map((file) => {
          const line = lineForText(file.sourceText, text);
          return {
            path: file.path,
            startLine: line,
            endLine: line,
            reason: "Exact text evidence",
          };
        }),
      };
    }
    case "file-changed": {
      const present = changedPaths.has(claim.check.path);
      return {
        claim,
        outcome: expectationMatches(present) ? "supported" : "rejected",
        explanation: present
          ? "The file is part of the collected change set."
          : "The file is not part of the collected change set.",
        evidence: present
          ? [{ path: claim.check.path, reason: "Git change-set evidence" }]
          : [],
      };
    }
  }
}

function verdictFor(
  findings: readonly ValidationFinding[],
  claims: readonly ValidationClaimResult[],
): ValidationVerdict {
  if (findings.some((item) => item.severity === "blocking")) return "block";
  if (
    findings.some((item) => item.kind === "missing-objective") ||
    findings.some((item) => item.kind === "contract-drift") ||
    claims.some((item) => item.outcome === "inconclusive")
  ) {
    return "inconclusive";
  }
  if (findings.some((item) => item.severity === "warning")) return "warn";
  return "pass";
}

export interface SuperValidatorOptions {
  readonly impactDepth?: number;
}

export interface ValidationRunContext {
  readonly previousReport?: ValidationReport;
  readonly receipts?: readonly EvidenceReceiptInput[];
  readonly seriesId?: string;
  readonly newSeries?: boolean;
  readonly stagnationThreshold?: number;
}

export class SuperValidator {
  readonly #impactDepth: number;

  public constructor(options: SuperValidatorOptions = {}) {
    this.#impactDepth = options.impactDepth ?? 2;
  }

  public validate(
    index: RepositoryCodeIndex,
    changeSet: ChangeSet,
    contract: ValidationContract,
    context: ValidationRunContext = {},
  ): ValidationReport {
    if (index.embedding.kind !== "deterministic-feature-hash") {
      throw new Error("SuperValidator requires deterministic local embeddings for evidence-backed review");
    }
    const started = performance.now();
    let deterministicChecks = 0;
    const findings: ValidationFinding[] = [];
    const changedPaths = new Set(changeSet.files.map((file) => file.path));
    const changedUnits = Object.values(index.units).filter((unit) => {
      const file = changeSet.files.find((item) => item.path === unit.path);
      return file !== undefined && intersectsChangedLines(unit, file);
    });
    const changedSymbols = new Set(changedUnits.map((unit) => unit.symbol));

    deterministicChecks += 1;
    if (changeSet.files.length === 0) {
      findings.push(finding(
        "no-change",
        "info",
        "Nothing to review in this comparison",
        "Git found no changed files between the selected inputs.",
        "Choose another base or source only if you expected a change; otherwise no action is needed.",
      ));
    }

    deterministicChecks += 1;
    if (contract.objective.trim() === "") {
      findings.push(finding(
        "missing-objective",
        "warning",
        "The resolution objective is missing",
        "Conclave can inspect structural impact but cannot compare it with an intended outcome.",
        "Provide --objective or a validation contract with an explicit objective.",
      ));
    }

    if (contract.allowedPathPrefixes.length > 0) {
      deterministicChecks += 1;
      const outside = changeSet.files.filter(
        (file) => !contract.allowedPathPrefixes.some((prefix) => pathMatchesPrefix(file.path, prefix)),
      );
      if (outside.length > 0) {
        findings.push(finding(
          "scope-expansion",
          "blocking",
          "The change expands beyond the allowed scope",
          "Changed files fall outside every path prefix allowed by the validation contract.",
          "Remove unrelated changes or explicitly expand the contract before revalidating.",
          outside.map((file) => ({ path: file.path, reason: "Changed outside allowed path prefixes" })),
        ));
      }
    }

    for (const changed of changeSet.files) {
      const file = index.files[changed.path];
      if (file !== undefined) {
        deterministicChecks += 1;
        for (const diagnostic of file.diagnostics.slice(0, 20)) {
          findings.push(finding(
            "parser-diagnostic",
            "blocking",
            "Changed source has a parser diagnostic",
            diagnostic.message,
            "Repair the syntax or parser-visible structural error before accepting the resolution.",
            [{
              path: changed.path,
              startLine: diagnostic.line,
              endLine: diagnostic.line,
              reason: "Language parser diagnostic",
            }],
          ));
        }
      }
    }

    // Text-visible defect classes the graph cannot express. These cost no model call, so the
    // free review path reports them too.
    const sourceAnalysis = analyzeSourceDefects(index, changeSet.files);
    deterministicChecks += sourceAnalysis.checksPerformed;
    for (const defect of sourceAnalysis.defects) {
      findings.push(finding(
        defect.kind,
        "warning",
        defect.title,
        defect.detail,
        defect.remediation,
        [defect.evidence],
      ));
    }

    deterministicChecks += 1;
    const deletedSource = changeSet.files.filter((changed) =>
      isSourceFile(changed.path) && !isTestFile(changed.path) && isDeletionOnly(changed));
    if (deletedSource.length > 0) {
      findings.push(finding(
        "head-only-deletion",
        "warning",
        "Deleted behavior deserves baseline review",
        `${String(deletedSource.length)} source file(s) were deleted. The current structural map describes the resulting tree, while the Git patch remains the baseline evidence for removed behavior.`,
        "Confirm that no remaining caller, import, public contract, or required behavior depends on the deleted code.",
        deletedSource.slice(0, 20).map((changed) => ({ path: changed.path, reason: "Git reports deleted source or deleted-only lines" })),
      ));
    }

    const startingKeys = new Set<string>();
    for (const path of changedPaths) {
      if (index.files[path] !== undefined) startingKeys.add("file:" + path);
    }
    for (const unit of changedUnits) startingKeys.add("symbol:" + unit.id);
    const impact = impactFrom(index, startingKeys, this.#impactDepth);
    const impactedFiles = new Set<string>();
    const impactedSymbols = new Set<string>();
    for (const key of impact.nodeKeys) {
      if (key.startsWith("file:")) {
        impactedFiles.add(key.slice("file:".length));
        continue;
      }
      const unit = index.units[key.slice("symbol:".length)];
      if (unit !== undefined) {
        impactedFiles.add(unit.path);
        impactedSymbols.add(unit.symbol);
      }
    }

    deterministicChecks += 1;
    const outsideImpactEdges = impact.edges.filter((edge) => {
      const fromPath = unitPath(index, edge.from);
      const toPath = unitPath(index, edge.to);
      return (
        (fromPath !== undefined && changedPaths.has(fromPath) && toPath !== undefined && !changedPaths.has(toPath)) ||
        (toPath !== undefined && changedPaths.has(toPath) && fromPath !== undefined && !changedPaths.has(fromPath))
      );
    });
    if (outsideImpactEdges.length > 0) {
      const outsidePaths = [...impactedFiles].filter((path) => !changedPaths.has(path)).sort();
      findings.push(finding(
        "impact-outside-diff",
        "warning",
        "The change affects code outside the diff",
        "Project-graph relationships reach " + String(outsidePaths.length) + " unchanged file(s): " +
          outsidePaths.slice(0, 8).join(", "),
        "Review the affected callers, references, imports, and contracts before accepting the resolution.",
        outsideImpactEdges.slice(0, 20).map(evidenceForEdge),
      ));
    }

    deterministicChecks += 1;
    const exportedChangedUnits = changedUnits.filter((unit) => unit.exported);
    const changedTests = changeSet.files.filter((file) => isTestFile(file.path));
    if (exportedChangedUnits.length > 0 && changedTests.length === 0) {
      findings.push(finding(
        "exported-change-without-tests",
        "warning",
        "Exported behavior changed without a test change",
        String(exportedChangedUnits.length) + " exported symbol(s) changed, but the diff contains no test file.",
        "Add or identify existing coverage that proves the changed public behavior.",
        exportedChangedUnits.slice(0, 20).map((unit) =>
          evidenceForUnit(unit, "Changed exported symbol without changed test evidence"),
        ),
      ));
    }

    deterministicChecks += 1;
    if (
      changeSet.files.some((file) => isSourceFile(file.path) && file.status !== "deleted") &&
      changedUnits.length === 0
    ) {
      findings.push(finding(
        "claim-inconclusive",
        "warning",
        "Changed source could not be mapped to a symbol",
        "The diff touches source code, but no current indexed symbol intersects the changed lines.",
        "Inspect file-level impact or improve parser/type-aware indexing before approving the resolution.",
        changeSet.files.filter((file) => isSourceFile(file.path)).map((file) => ({
          path: file.path,
          reason: "Changed source has no intersecting indexed symbol",
        })),
      ));
    }

    deterministicChecks += contract.claims.length;
    const claims = contract.claims.map((claim) => claimResult(index, changedPaths, claim));
    for (const result of claims) {
      if (result.outcome === "rejected") {
        findings.push(finding(
          "claim-contradicted",
          "blocking",
          "A resolution claim is contradicted",
          result.claim.statement + " — " + result.explanation,
          "Correct the implementation or remove the false completion claim.",
          result.evidence,
          "claim:" + result.claim.id,
        ));
      } else if (result.outcome === "inconclusive") {
        findings.push(finding(
          "claim-inconclusive",
          "warning",
          "A resolution claim could not be proven",
          result.claim.statement + " — " + result.explanation,
          "Add a deterministic check or more precise evidence for this claim.",
          result.evidence,
          "claim:" + result.claim.id,
        ));
      }
    }

    const effectivePrevious = context.newSeries === true ? undefined : context.previousReport;
    deterministicChecks += 1;
    const lineage = createValidationLineage({
      changeSet,
      contract,
      ...(effectivePrevious === undefined ? {} : { previousReport: effectivePrevious }),
      ...(context.seriesId === undefined ? {} : { requestedSeriesId: context.seriesId }),
      ...(context.newSeries === undefined ? {} : { newSeries: context.newSeries }),
    });
    if (lineage.rebaselineRequired) {
      const changes = [
        ...(lineage.contractDelta.objectiveChanged ? ["objective changed"] : []),
        ...(lineage.contractDelta.removedClaimIds.length > 0
          ? ["removed claims: " + lineage.contractDelta.removedClaimIds.join(", ")]
          : []),
        ...(lineage.contractDelta.changedClaimIds.length > 0
          ? ["changed claims: " + lineage.contractDelta.changedClaimIds.join(", ")]
          : []),
        ...(lineage.contractDelta.allowedPathPrefixesAdded.length > 0 || lineage.contractDelta.allowedPathPrefixesRemoved.length > 0
          ? ["allowed path prefixes changed"]
          : []),
        ...(lineage.baselineTrust === "invalid" ? ["previous report digest is invalid"] : []),
      ];
      findings.push(finding(
        "contract-drift",
        "warning",
        "The review contract requires a deliberate rebaseline",
        changes.length === 0 ? "The previous review cannot be compared safely." : changes.join("; ") + ".",
        "Confirm the changed objective or contract at a trusted boundary, then start a new review series explicitly.",
      ));
    }
    const mutableSource = changeSet.source.kind === "working" ||
      changeSet.source.kind === "workspace" ||
      changeSet.source.kind === "staged";
    const receipts = evaluateEvidenceReceipts(context.receipts ?? [], lineage, changeSet.headSha, mutableSource);
    deterministicChecks += receipts.items.length;
    for (const receipt of receipts.items) {
      if (receipt.status === "current") continue;
      const receiptKind = receipt.status === "stale"
        ? "receipt-stale" as const
        : receipt.status === "failed"
          ? "receipt-failed" as const
          : "receipt-invalid" as const;
      findings.push(finding(
        receiptKind,
        "warning",
        receipt.status === "failed"
          ? "An external check reports failure"
          : receipt.status === "stale"
            ? "External evidence is stale"
            : "External evidence cannot support this review",
        receipt.id + ": " + receipt.reasons.join("; "),
        receipt.status === "failed"
          ? "Correct the failing behavior and produce a new receipt bound to the reviewed artifact."
          : "Produce a valid receipt whose artifact, diff, or HEAD binding matches this review.",
        [],
        "receipt:" + receipt.id,
      ));
    }

    const verdict = verdictFor(findings, claims);
    const counts = {
      blocking: findings.filter((item) => item.severity === "blocking").length,
      warning: findings.filter((item) => item.severity === "warning").length,
    };
    const findingLifecycle = createFindingLifecycle(
      findings,
      lineage,
      lineage.baselineTrust === "invalid" || lineage.rebaselineRequired ? undefined : effectivePrevious,
      context.stagnationThreshold,
    );
    const challengePlan = createChallengePlan(
      changeSet,
      contract,
      changedUnits,
      impactedFiles,
      findings,
    );
    const report: ValidationReport = {
      schemaVersion: 4,
      criteria: evaluateCriteria(contract.criteria ?? [], claims, receipts, lineage.rebaselineRequired ? undefined : effectivePrevious),
      verdict,
      summary:
        verdict.toUpperCase() + ": " + String(counts.blocking) + " blocking, " +
        String(counts.warning) + " warning; " + String(impactedFiles.size) + " impacted file(s).",
      objective: contract.objective,
      changeSet: {
        source: changeSet.source,
        headSha: changeSet.headSha,
        files: changeSet.files,
        collectedAt: changeSet.collectedAt,
        patchBytes: Buffer.byteLength(changeSet.patch, "utf8"),
      },
      findings,
      claims,
      impact: {
        changedSymbols: [...changedSymbols].sort(),
        impactedFiles: [...impactedFiles].sort(),
        impactedSymbols: [...impactedSymbols].sort(),
      },
      metrics: {
        filesChanged: changeSet.files.length,
        symbolsChanged: changedSymbols.size,
        impactedFiles: impactedFiles.size,
        impactedSymbols: impactedSymbols.size,
        graphEdgesInspected: impact.edges.length,
        deterministicChecks,
        durationMs: Math.max(0, performance.now() - started),
      },
      trustBoundary: {
        deterministic: true,
        reasoningModelCalls: 0,
        repositoryScriptsExecuted: false,
        knowledge: {
          parser: index.parserId,
          graph: "syntax-aware",
          embedding: {
            id: index.embedding.id,
            kind: "deterministic-feature-hash",
            remoteCalls: 0,
          },
        },
      },
      lineage,
      findingLifecycle,
      receipts,
      challengePlan,
      escalation: assessEscalation(challengePlan, findings, claims, {
        files: changeSet.files,
        indexedPaths: new Set(Object.keys(index.files)),
      }),
    };
    return finalizeReportDigest(report);
  }
}
