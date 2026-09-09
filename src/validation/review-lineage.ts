import { createHash } from "node:crypto";

import type {
  ChangeSet,
  ValidationContract,
  ValidationContractDelta,
  ValidationContractSnapshot,
  ValidationFinding,
  ValidationFindingLifecycle,
  ValidationLineage,
  ValidationReport,
} from "../domain/validation.js";

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

export function validationDigest(label: string, value: unknown): string {
  return label + "_" + createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function sourceIdentity(changeSet: ChangeSet): unknown {
  switch (changeSet.source.kind) {
    case "workspace":
      return { kind: changeSet.source.kind, base: changeSet.source.base };
    case "branch":
      return { kind: changeSet.source.kind, base: changeSet.source.base };
    case "commit":
      return { kind: changeSet.source.kind, commit: changeSet.source.commit };
    case "working":
    case "staged":
      return { kind: changeSet.source.kind };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertComparableReport(value: ValidationReport): void {
  const report = record(value);
  const lineage = record(report?.["lineage"]);
  const snapshot = record(lineage?.["contractSnapshot"]);
  const lifecycle = record(report?.["findingLifecycle"]);
  const claims = snapshot?.["claims"];
  const current = lifecycle?.["current"];
  const validClaimDigests = Array.isArray(claims) && claims.every((item) => {
    const claim = record(item);
    return typeof claim?.["id"] === "string" && typeof claim["digest"] === "string";
  });
  const validOccurrences = Array.isArray(current) && current.every((item) => {
    const occurrence = record(item);
    return typeof occurrence?.["fingerprint"] === "string" &&
      Number.isInteger(occurrence["occurrences"]) &&
      (occurrence["occurrences"] as number) >= 1 &&
      Number.isInteger(occurrence["consecutive"]) &&
      (occurrence["consecutive"] as number) >= 1;
  });
  if (
    (report?.["schemaVersion"] !== 2 && report?.["schemaVersion"] !== 3 && report?.["schemaVersion"] !== 4 && report?.["schemaVersion"] !== 5) ||
    typeof lineage?.["seriesId"] !== "string" ||
    typeof lineage["reviewId"] !== "string" ||
    typeof lineage["reportDigest"] !== "string" ||
    typeof lineage["objectiveDigest"] !== "string" ||
    typeof lineage["diffDigest"] !== "string" ||
    !Array.isArray(snapshot?.["allowedPathPrefixes"]) ||
    !snapshot["allowedPathPrefixes"].every((item) => typeof item === "string") ||
    !validClaimDigests ||
    !validOccurrences ||
    !Array.isArray(lifecycle?.["seen"]) ||
    !lifecycle["seen"].every((item) => typeof item === "string")
  ) {
    throw new Error("Previous report is not a comparable Conclave schema v2/v3/v4/v5 report");
  }
}

function normalizedContract(contract: ValidationContract): ValidationContract {
  const duplicateClaimId = contract.claims.find((item, index) =>
    contract.claims.findIndex((candidate) => candidate.id === item.id) !== index,
  )?.id;
  if (duplicateClaimId !== undefined) throw new Error("Validation contract contains a duplicate claim id: " + duplicateClaimId);
  return {
    ...(contract.criteria === undefined ? {} : { criteria: [...contract.criteria].sort((a, b) => a.id.localeCompare(b.id)) }),
    objective: contract.objective.trim(),
    allowedPathPrefixes: [...new Set(contract.allowedPathPrefixes.map((path) =>
      path.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, ""),
    ))].sort(),
    claims: [...contract.claims]
      .map((claim) => ({
        ...claim,
        statement: claim.statement.trim(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function contractSnapshot(contract: ValidationContract): ValidationContractSnapshot {
  const normalized = normalizedContract(contract);
  return {
    allowedPathPrefixes: normalized.allowedPathPrefixes,
    claims: [
      ...normalized.claims.map((claim) => ({ id: claim.id, digest: validationDigest("claim", claim) })),
      ...(normalized.criteria ?? []).map((item) => ({ id: "criterion:" + item.id, digest: validationDigest("criterion", item) })),
    ],
  };
}

function stringDifference(left: readonly string[], right: readonly string[]): readonly string[] {
  const rightSet = new Set(right);
  return left.filter((item) => !rightSet.has(item)).sort();
}

function contractDelta(
  objectiveDigest: string,
  snapshot: ValidationContractSnapshot,
  previous?: ValidationReport,
): ValidationContractDelta {
  if (previous === undefined) {
    return {
      objectiveChanged: false,
      addedClaimIds: [],
      removedClaimIds: [],
      changedClaimIds: [],
      allowedPathPrefixesAdded: [],
      allowedPathPrefixesRemoved: [],
    };
  }
  const currentClaims = new Map(snapshot.claims.map((claim) => [claim.id, claim.digest]));
  const previousClaims = new Map(previous.lineage.contractSnapshot.claims.map((claim) => [claim.id, claim.digest]));
  const addedClaimIds = [...currentClaims.keys()].filter((id) => !previousClaims.has(id)).sort();
  const removedClaimIds = [...previousClaims.keys()].filter((id) => !currentClaims.has(id)).sort();
  const changedClaimIds = [...currentClaims.entries()]
    .filter(([id, digest]) => previousClaims.has(id) && previousClaims.get(id) !== digest)
    .map(([id]) => id)
    .sort();
  return {
    objectiveChanged: previous.lineage.objectiveDigest !== objectiveDigest,
    addedClaimIds,
    removedClaimIds,
    changedClaimIds,
    allowedPathPrefixesAdded: stringDifference(
      snapshot.allowedPathPrefixes,
      previous.lineage.contractSnapshot.allowedPathPrefixes,
    ),
    allowedPathPrefixesRemoved: stringDifference(
      previous.lineage.contractSnapshot.allowedPathPrefixes,
      snapshot.allowedPathPrefixes,
    ),
  };
}

function hasMaterialDelta(delta: ValidationContractDelta): boolean {
  return delta.objectiveChanged ||
    delta.addedClaimIds.length > 0 ||
    delta.removedClaimIds.length > 0 ||
    delta.changedClaimIds.length > 0 ||
    delta.allowedPathPrefixesAdded.length > 0 ||
    delta.allowedPathPrefixesRemoved.length > 0;
}

function previousReportDigest(report: ValidationReport): string {
  return validationDigest("report", {
    ...report,
    lineage: { ...report.lineage, reportDigest: "" },
  });
}

export interface CreateValidationLineageInput {
  readonly changeSet: ChangeSet;
  readonly contract: ValidationContract;
  readonly previousReport?: ValidationReport;
  readonly requestedSeriesId?: string;
  readonly newSeries?: boolean;
}

export function createValidationLineage(input: CreateValidationLineageInput): ValidationLineage {
  if (input.previousReport !== undefined) assertComparableReport(input.previousReport);
  const normalized = normalizedContract(input.contract);
  const objectiveDigest = validationDigest("objective", normalized.objective);
  const contractDigest = validationDigest("contract", normalized);
  const diffDigest = validationDigest("diff", input.changeSet.patch);
  const artifactDigest = validationDigest("artifact", {
    source: input.changeSet.source,
    headSha: input.changeSet.headSha,
    diffDigest,
    files: input.changeSet.files,
  });
  const effectivePrevious = input.newSeries === true ? undefined : input.previousReport;
  const computedPreviousDigest = effectivePrevious === undefined ? undefined : previousReportDigest(effectivePrevious);
  const previousIsValid = effectivePrevious === undefined || computedPreviousDigest === effectivePrevious.lineage.reportDigest;
  const snapshot = contractSnapshot(normalized);
  const delta = contractDelta(objectiveDigest, snapshot, effectivePrevious);
  const prefixesChanged = delta.allowedPathPrefixesAdded.length > 0 || delta.allowedPathPrefixesRemoved.length > 0;
  const unsafeDelta = delta.objectiveChanged || delta.removedClaimIds.length > 0 ||
    delta.changedClaimIds.length > 0 || prefixesChanged;
  const contractStatus = effectivePrevious === undefined
    ? "initial" as const
    : !previousIsValid || unsafeDelta
      ? "rebaseline-required" as const
      : delta.addedClaimIds.length > 0
        ? "strengthened" as const
        : hasMaterialDelta(delta)
          ? "rebaseline-required" as const
          : "preserved" as const;
  const inheritedSeries = effectivePrevious?.lineage.seriesId;
  if (
    effectivePrevious !== undefined && input.requestedSeriesId !== undefined &&
    input.requestedSeriesId !== inheritedSeries
  ) {
    throw new Error("--series does not match the previous report; use --new-series for an intentional rebaseline");
  }
  const seriesId = input.requestedSeriesId ?? inheritedSeries ?? validationDigest("series", {
    objectiveDigest,
    source: sourceIdentity(input.changeSet),
    ...(input.newSeries === true
      ? { rebaselineArtifactDigest: artifactDigest, rebaselineCollectedAt: input.changeSet.collectedAt }
      : {}),
  }).slice(0, 31);
  const reviewId = validationDigest("review", {
    seriesId,
    artifactDigest,
    contractDigest,
    previousReportDigest: computedPreviousDigest,
  }).slice(0, 31);
  return {
    seriesId,
    reviewId,
    ...(effectivePrevious === undefined ? {} : { previousReviewId: effectivePrevious.lineage.reviewId }),
    ...(computedPreviousDigest === undefined ? {} : { previousReportDigest: computedPreviousDigest }),
    baselineTrust: effectivePrevious === undefined ? "none" : previousIsValid ? "unattested" : "invalid",
    objectiveDigest,
    contractDigest,
    diffDigest,
    artifactDigest,
    reportDigest: "",
    contractStatus,
    rebaselineRequired: contractStatus === "rebaseline-required",
    contractDelta: delta,
    contractSnapshot: snapshot,
  };
}

function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort();
}

export function createFindingLifecycle(
  findings: readonly ValidationFinding[],
  lineage: ValidationLineage,
  previousReport?: ValidationReport,
  stagnationThreshold = 3,
): ValidationFindingLifecycle {
  const currentFingerprints = sortedUnique(findings.map((item) => item.fingerprint));
  const threshold = Number.isInteger(stagnationThreshold) && stagnationThreshold >= 2 && stagnationThreshold <= 20
    ? stagnationThreshold
    : 3;
  if (previousReport === undefined) {
    return {
      progress: "initial",
      current: currentFingerprints.map((fingerprint) => ({
        fingerprint,
        status: "new",
        occurrences: 1,
        consecutive: 1,
      })),
      resolved: [],
      seen: currentFingerprints,
      stagnating: [],
    };
  }
  const previousCurrent = new Map(previousReport.findingLifecycle.current.map((item) => [item.fingerprint, item]));
  const previousSeen = new Set(previousReport.findingLifecycle.seen);
  const duplicate = lineage.diffDigest === previousReport.lineage.diffDigest;
  const current = currentFingerprints.map((fingerprint) => {
    const prior = previousCurrent.get(fingerprint);
    const status = prior !== undefined ? "persistent" as const : previousSeen.has(fingerprint) ? "regressed" as const : "new" as const;
    return {
      fingerprint,
      status,
      occurrences: (prior?.occurrences ?? (previousSeen.has(fingerprint) ? 1 : 0)) + 1,
      consecutive: prior === undefined ? 1 : duplicate ? prior.consecutive : prior.consecutive + 1,
    };
  });
  const currentSet = new Set(currentFingerprints);
  const resolved = [...previousCurrent.keys()].filter((fingerprint) => !currentSet.has(fingerprint)).sort();
  const stagnating = duplicate
    ? []
    : current.filter((item) => item.consecutive >= threshold).map((item) => item.fingerprint).sort();
  const regressed = current.some((item) => item.status === "regressed");
  const introduced = current.some((item) => item.status === "new");
  const progress = duplicate
    ? "duplicate-recheck" as const
    : regressed
      ? "regression" as const
      : stagnating.length > 0
        ? "stagnant" as const
        : resolved.length > 0 && introduced
          ? "mixed" as const
          : resolved.length > 0
            ? "progress" as const
          : "mixed" as const;
  return {
    progress,
    current,
    resolved,
    seen: sortedUnique([...previousSeen, ...currentFingerprints]),
    stagnating,
  };
}

export function finalizeReportDigest(report: ValidationReport): ValidationReport {
  const reportDigest = previousReportDigest(report);
  return {
    ...report,
    lineage: {
      ...report.lineage,
      reportDigest,
    },
  };
}
