import type {
  AcceptanceCriterion,
  ValidationClaim,
  ValidationClaimCheck,
  ValidationContract,
} from "../domain/validation.js";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(label + " must be an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(label + " must be a non-empty string");
  }
  return value.trim();
}

function expectation(value: unknown, label: string): "present" | "absent" {
  if (value !== "present" && value !== "absent") {
    throw new Error(label + " must be present or absent");
  }
  return value;
}

function claimCheck(value: unknown, label: string): ValidationClaimCheck {
  const parsed = record(value, label);
  const kind = string(parsed["kind"], label + ".kind");
  const expected = expectation(parsed["expectation"], label + ".expectation");
  switch (kind) {
    case "symbol-exists":
      return { kind, symbol: string(parsed["symbol"], label + ".symbol"), expectation: expected };
    case "callers":
      return { kind, symbol: string(parsed["symbol"], label + ".symbol"), expectation: expected };
    case "references":
      return { kind, symbol: string(parsed["symbol"], label + ".symbol"), expectation: expected };
    case "text":
      return { kind, text: string(parsed["text"], label + ".text"), expectation: expected };
    case "file-changed":
      return { kind, path: string(parsed["path"], label + ".path"), expectation: expected };
    default:
      throw new Error(label + ".kind is unsupported");
  }
}

function claim(value: unknown, index: number): ValidationClaim {
  const label = "claims[" + String(index) + "]";
  const parsed = record(value, label);
  return {
    id: string(parsed["id"], label + ".id"),
    statement: string(parsed["statement"], label + ".statement"),
    check: claimCheck(parsed["check"], label + ".check"),
  };
}

function strings(value: unknown, label: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) throw new Error(label + " must be an array of at most 100 strings");
  return [...new Set(value.map((item) => string(item, label)))];
}

function criterion(value: unknown, index: number): AcceptanceCriterion {
  const label = "criteria[" + String(index) + "]";
  const parsed = record(value, label);
  const id = string(parsed["id"], label + ".id");
  if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(id)) throw new Error(label + ".id must be a stable identifier (letters, numbers, - or _)");
  const kind = parsed["kind"];
  if (kind !== "structural" && kind !== "test" && kind !== "runtime" && kind !== "human") throw new Error(label + ".kind is unsupported");
  if (typeof parsed["confirmed"] !== "boolean") throw new Error(label + ".confirmed must be explicit");
  const statement = string(parsed["statement"], label + ".statement");
  const verificationPlan = string(parsed["verificationPlan"], label + ".verificationPlan");
  if (statement.length > 2000 || verificationPlan.length > 4000) throw new Error(label + " is too long");
  return { id, statement, verificationPlan, kind, confirmed: parsed["confirmed"], claimIds: strings(parsed["claimIds"], label + ".claimIds"), implementationPaths: strings(parsed["implementationPaths"], label + ".implementationPaths") };
}

export function parseValidationContract(
  value: unknown,
  objectiveOverride?: string,
): ValidationContract {
  const parsed = record(value, "Validation contract");
  const rawClaims = parsed["claims"] ?? [];
  const rawPrefixes = parsed["allowedPathPrefixes"] ?? [];
  if (!Array.isArray(rawClaims)) throw new Error("claims must be an array");
  if (!Array.isArray(rawPrefixes)) throw new Error("allowedPathPrefixes must be an array");
  const objectiveValue = objectiveOverride ?? parsed["objective"] ?? "";
  if (typeof objectiveValue !== "string") throw new Error("objective must be a string");
  const claims = rawClaims.map((item, index) => claim(item, index));
  const duplicateClaimId = claims.find((item, index) =>
    claims.findIndex((candidate) => candidate.id === item.id) !== index,
  )?.id;
  if (claims.some((item) => item.id.startsWith("criterion:"))) throw new Error("claim ids cannot use the reserved criterion: prefix");
  if (duplicateClaimId !== undefined) throw new Error("claims contain a duplicate id: " + duplicateClaimId);
  const rawCriteria = parsed["criteria"];
  if (rawCriteria !== undefined && (!Array.isArray(rawCriteria) || rawCriteria.length > 100)) throw new Error("criteria must be an array of at most 100 entries");
  const criteria = rawCriteria === undefined ? undefined : (rawCriteria as unknown[]).map(criterion);
  if (criteria !== undefined && new Set(criteria.map((item) => item.id)).size !== criteria.length) throw new Error("criteria contain duplicate ids");
  for (const item of criteria ?? []) {
    if (item.claimIds.some((id) => !claims.some((entry) => entry.id === id))) throw new Error("criterion references an unknown claim: " + item.id);
  }
  return {
    ...(criteria === undefined ? {} : { criteria }),
    objective: objectiveValue.trim(),
    claims,
    allowedPathPrefixes: rawPrefixes.map((item, index) =>
      string(item, "allowedPathPrefixes[" + String(index) + "]"),
    ),
  };
}

export function createValidationContract(objective: string): ValidationContract {
  return {
    objective: objective.trim(),
    claims: [],
    allowedPathPrefixes: [],
  };
}
