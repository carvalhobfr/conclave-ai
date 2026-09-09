import { hasVerifiedProvenance } from "./attested-evidence.js";
import { createHash } from "node:crypto";

import type {
  EvidenceReceiptClaimedTrust,
  EvidenceReceiptInput,
  EvidenceReceiptStatus,
  EvidenceReceiptType,
  ValidationLineage,
  ValidationReceiptSummary,
  ValidatedEvidenceReceipt,
} from "../domain/validation.js";
import { validationDigest } from "./review-lineage.js";

const MAX_RECEIPTS = 20;
const MAX_SUMMARY_LENGTH = 1_000;
const MAX_COMMAND_LENGTH = 1_000;
const MAX_RUNNER_LENGTH = 200;
const TYPES: readonly EvidenceReceiptType[] = ["test", "build", "lint", "typecheck", "benchmark", "runtime", "other"];
const TRUST_LEVELS: readonly EvidenceReceiptClaimedTrust[] = ["self-reported", "locally-observed", "ci-attested"];

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedString(value: unknown, maximum: number, label: string, errors: string[]): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    errors.push(label + " must be a non-empty string");
    return undefined;
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    errors.push(label + " exceeds " + String(maximum) + " characters");
    return normalized.slice(0, maximum);
  }
  return normalized;
}

function digest(value: unknown, label: string, errors: string[]): string | undefined {
  const normalized = boundedString(value, 160, label, errors);
  if (normalized !== undefined && !/^(?:[a-z]+_)?[a-f0-9]{64}$/u.test(normalized)) {
    errors.push(label + " must be a SHA-256 digest");
  }
  return normalized;
}

function date(value: unknown, label: string, errors: string[]): string | undefined {
  const normalized = boundedString(value, 100, label, errors);
  if (normalized !== undefined && Number.isNaN(Date.parse(normalized))) errors.push(label + " must be an ISO date-time");
  return normalized;
}

function parseReceipt(value: unknown, index: number, source: string): EvidenceReceiptInput {
  const parsed = object(value);
  const errors: string[] = [];
  if (parsed === undefined) {
    return {
      id: "invalid-" + createHash("sha256").update(source + ":" + String(index)).digest("hex").slice(0, 12),
      type: "other",
      validationErrors: ["receipt must be an object"],
    };
  }
  const id = boundedString(parsed["id"], 120, "id", errors) ??
    "invalid-" + createHash("sha256").update(source + ":" + String(index)).digest("hex").slice(0, 12);
  const rawType = parsed["type"];
  const type = typeof rawType === "string" && TYPES.includes(rawType as EvidenceReceiptType)
    ? rawType as EvidenceReceiptType
    : "other";
  if (rawType !== undefined && type === "other" && rawType !== "other") errors.push("type is unsupported");
  const rawTrust = parsed["trustLevel"] ?? parsed["claimedTrustLevel"];
  const claimedTrustLevel = typeof rawTrust === "string" && TRUST_LEVELS.includes(rawTrust as EvidenceReceiptClaimedTrust)
    ? rawTrust as EvidenceReceiptClaimedTrust
    : "self-reported";
  if (rawTrust !== undefined && claimedTrustLevel === "self-reported" && rawTrust !== "self-reported") {
    errors.push("trustLevel is unsupported");
  }
  const exitCode = parsed["exitCode"];
  if (exitCode !== undefined && (!Number.isInteger(exitCode) || (exitCode as number) < 0)) {
    errors.push("exitCode must be a non-negative integer");
  }
  const rawArtifactDigests = parsed["artifactDigests"];
  const artifactDigests = Array.isArray(rawArtifactDigests)
    ? rawArtifactDigests.slice(0, 20).map((item, digestIndex) =>
      digest(item, "artifactDigests[" + String(digestIndex) + "]", errors),
    ).filter((item): item is string => item !== undefined)
    : undefined;
  if (rawArtifactDigests !== undefined && !Array.isArray(rawArtifactDigests)) errors.push("artifactDigests must be an array");
  if (Array.isArray(rawArtifactDigests) && rawArtifactDigests.length > 20) {
    errors.push("artifactDigests exceeds the limit of 20");
  }
  const rawCriterionDigests = parsed["criterionDigests"];
  const criterionDigests: Record<string, string> = {};
  if (rawCriterionDigests !== undefined) {
    const links = object(rawCriterionDigests);
    if (links === undefined || Object.keys(links).length > 100) errors.push("criterionDigests must be an object with at most 100 entries");
    else for (const [id, value] of Object.entries(links)) {
      if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(id)) errors.push("invalid criterion id");
      const checked = digest(value, "criterionDigests." + id, errors);
      if (checked !== undefined) Object.defineProperty(criterionDigests, id, { value: checked, enumerable: true });
    }
  }
  const startedAt = date(parsed["startedAt"], "startedAt", errors);
  const finishedAt = date(parsed["finishedAt"], "finishedAt", errors);
  if (
    startedAt !== undefined && finishedAt !== undefined &&
    !Number.isNaN(Date.parse(startedAt)) && !Number.isNaN(Date.parse(finishedAt)) &&
    Date.parse(finishedAt) < Date.parse(startedAt)
  ) {
    errors.push("finishedAt must not be earlier than startedAt");
  }
  return {
    id,
    type,
    ...(rawCriterionDigests === undefined ? {} : { criterionDigests }),
    ...((value => value === undefined ? {} : { command: value })(boundedString(parsed["command"], MAX_COMMAND_LENGTH, "command", errors))),
    ...(typeof exitCode === "number" && Number.isInteger(exitCode) && exitCode >= 0 ? { exitCode } : {}),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...((value => value === undefined ? {} : { headSha: value })(boundedString(parsed["headSha"], 160, "headSha", errors))),
    ...((value => value === undefined ? {} : { artifactDigest: value })(digest(parsed["artifactDigest"] ?? parsed["workspaceDigest"], "artifactDigest", errors))),
    ...((value => value === undefined ? {} : { diffDigest: value })(digest(parsed["diffDigest"], "diffDigest", errors))),
    ...((value => value === undefined ? {} : { outputDigest: value })(digest(parsed["outputDigest"], "outputDigest", errors))),
    ...(artifactDigests === undefined ? {} : { artifactDigests }),
    ...((value => value === undefined ? {} : { runner: value })(boundedString(parsed["runner"], MAX_RUNNER_LENGTH, "runner", errors))),
    claimedTrustLevel,
    ...((value => value === undefined ? {} : { summary: value })(boundedString(parsed["summary"], MAX_SUMMARY_LENGTH, "summary", errors))),
    validationErrors: errors,
  };
}

export function parseEvidenceReceiptEnvelope(value: unknown, source = "receipt"): readonly EvidenceReceiptInput[] {
  const parsed = object(value);
  if (parsed === undefined || parsed["version"] !== 1 || !Array.isArray(parsed["receipts"])) {
    return [{
      id: "invalid-" + createHash("sha256").update(source).digest("hex").slice(0, 12),
      type: "other",
      validationErrors: ["receipt envelope must be an object with version 1 and a receipts array"],
    }];
  }
  const values = parsed["receipts"];
  const receipts = values.slice(0, MAX_RECEIPTS).map((item, index) => parseReceipt(item, index, source));
  if (values.length > MAX_RECEIPTS) {
    receipts.push({
      id: "invalid-limit-" + createHash("sha256").update(source).digest("hex").slice(0, 12),
      type: "other",
      validationErrors: ["receipt envelope exceeds the limit of " + String(MAX_RECEIPTS)],
    });
  }
  return receipts;
}

function receiptStatus(
  receipt: EvidenceReceiptInput,
  lineage: ValidationLineage,
  headSha: string,
  mutableSource: boolean,
): { readonly status: EvidenceReceiptStatus; readonly reasons: readonly string[] } {
  const errors = [...(receipt.validationErrors ?? [])];
  if (errors.length > 0) return { status: "invalid", reasons: errors };
  const bindings = [receipt.artifactDigest, receipt.diffDigest, receipt.headSha].filter((item): item is string => item !== undefined);
  if (bindings.length === 0) return { status: "unbound", reasons: ["receipt has no artifact, diff, or HEAD binding"] };
  if (mutableSource && receipt.artifactDigest === undefined && receipt.diffDigest === undefined) {
    return {
      status: "unbound",
      reasons: ["a mutable worktree receipt must bind to the artifact or diff digest; HEAD alone is insufficient"],
    };
  }
  const missingMetadata = [
    ...(receipt.command === undefined ? ["command"] : []),
    ...(receipt.exitCode === undefined ? ["exitCode"] : []),
    ...(receipt.startedAt === undefined ? ["startedAt"] : []),
    ...(receipt.finishedAt === undefined ? ["finishedAt"] : []),
    ...(receipt.outputDigest === undefined ? ["outputDigest"] : []),
    ...(receipt.runner === undefined ? ["runner"] : []),
  ];
  if (missingMetadata.length > 0) {
    return { status: "unbound", reasons: ["receipt is missing required evidence metadata: " + missingMetadata.join(", ")] };
  }
  const staleReasons: string[] = [];
  if (receipt.artifactDigest !== undefined && receipt.artifactDigest !== lineage.artifactDigest) {
    staleReasons.push("artifact digest does not match the reviewed artifact");
  }
  if (receipt.diffDigest !== undefined && receipt.diffDigest !== lineage.diffDigest) {
    staleReasons.push("diff digest does not match the reviewed change");
  }
  if (receipt.headSha !== undefined && receipt.headSha !== headSha) {
    staleReasons.push("HEAD SHA does not match the reviewed snapshot");
  }
  if (staleReasons.length > 0) return { status: "stale", reasons: staleReasons };
  if ((receipt.exitCode ?? 0) !== 0) return { status: "failed", reasons: ["receipt reports a non-zero exit code"] };
  return { status: "current", reasons: ["receipt bindings match the reviewed artifact"] };
}

export function evaluateEvidenceReceipts(
  receipts: readonly EvidenceReceiptInput[],
  lineage: ValidationLineage,
  headSha: string,
  mutableSource = false,
): ValidationReceiptSummary {
  const limited = receipts.slice(0, MAX_RECEIPTS);
  if (receipts.length > MAX_RECEIPTS) {
    limited.push({
      id: "invalid-total-limit",
      type: "other",
      validationErrors: ["review exceeds the total receipt limit of " + String(MAX_RECEIPTS)],
    });
  }
  const duplicateIds = new Set(
    limited
      .map((receipt) => receipt.id)
      .filter((id, index, ids) => ids.indexOf(id) !== index),
  );
  const normalized = limited.map((receipt): EvidenceReceiptInput => duplicateIds.has(receipt.id)
    ? {
        ...receipt,
        validationErrors: [...(receipt.validationErrors ?? []), "receipt id is duplicated in this review"],
      }
    : receipt);
  const items: ValidatedEvidenceReceipt[] = normalized.map((receipt) => {
    const evaluated = receiptStatus(receipt, lineage, headSha, mutableSource);
    return {
      id: receipt.id,
      ...(receipt.criterionDigests === undefined ? {} : { criterionDigests: receipt.criterionDigests }),
      receiptDigest: validationDigest("receipt", receipt),
      type: receipt.type,
      status: evaluated.status,
      claimedTrustLevel: receipt.claimedTrustLevel ?? "self-reported",
      effectiveTrustLevel: hasVerifiedProvenance(receipt) ? "ci-verified" : "self-reported",
      ...(receipt.command === undefined ? {} : { command: receipt.command }),
      ...(receipt.exitCode === undefined ? {} : { exitCode: receipt.exitCode }),
      ...(receipt.startedAt === undefined ? {} : { startedAt: receipt.startedAt }),
      ...(receipt.finishedAt === undefined ? {} : { finishedAt: receipt.finishedAt }),
      ...(receipt.headSha === undefined ? {} : { headSha: receipt.headSha }),
      ...(receipt.artifactDigest === undefined ? {} : { artifactDigest: receipt.artifactDigest }),
      ...(receipt.diffDigest === undefined ? {} : { diffDigest: receipt.diffDigest }),
      ...(receipt.outputDigest === undefined ? {} : { outputDigest: receipt.outputDigest }),
      ...(receipt.artifactDigests === undefined ? {} : { artifactDigests: receipt.artifactDigests }),
      ...(receipt.runner === undefined ? {} : { runner: receipt.runner }),
      ...(receipt.summary === undefined ? {} : { summary: receipt.summary }),
      reasons: [
        ...evaluated.reasons,
        ...(hasVerifiedProvenance(receipt) || receipt.claimedTrustLevel === undefined || receipt.claimedTrustLevel === "self-reported"
          ? []
          : ["claimed trust level is not cryptographically verified and is treated as self-reported"]),
      ],
    };
  });
  const statuses: readonly EvidenceReceiptStatus[] = ["current", "stale", "invalid", "failed", "unbound"];
  return {
    items,
    counts: Object.fromEntries(statuses.map((status) => [status, items.filter((item) => item.status === status).length])) as Readonly<Record<EvidenceReceiptStatus, number>>,
  };
}
