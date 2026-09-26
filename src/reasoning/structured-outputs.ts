import type {
  ChallengeType,
  ClaimCheck,
  ClaimUncertainty,
  RetrievalRequest,
  VerificationMethod,
  VerificationOutcome,
} from "../domain/reasoning.js";

export class StructuredOutputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

export interface ProposedClaimOutput {
  readonly statement: string;
  readonly evidenceIds: readonly string[];
  readonly uncertainty: ClaimUncertainty;
  readonly check?: ClaimCheck;
}

export interface InvestigatorOutput {
  readonly summary: string;
  readonly claims: readonly ProposedClaimOutput[];
  readonly retrievalRequests: readonly RetrievalRequest[];
}

export interface ChallengeOutput {
  readonly claimId: string;
  readonly type: ChallengeType;
  readonly explanation: string;
  readonly retrievalRequests: readonly RetrievalRequest[];
}

export interface SkepticOutput {
  readonly challenges: readonly ChallengeOutput[];
}

export interface ArchitectOutput {
  readonly summary: string;
  readonly challenges: readonly ChallengeOutput[];
  readonly retrievalRequests: readonly {
    readonly claimId?: string;
    readonly request: RetrievalRequest;
  }[];
  readonly discardedItems: number;
}

export interface VerifierDecisionOutput {
  readonly claimId: string;
  readonly outcome: VerificationOutcome;
  readonly method: VerificationMethod;
  readonly explanation: string;
  readonly evidenceIds: readonly string[];
  readonly graphEdgeIds: readonly string[];
}

export interface VerifierOutput {
  readonly decisions: readonly VerifierDecisionOutput[];
}

export interface JudgeOutput {
  readonly decisions: readonly {
    readonly claimId: string;
    readonly status: VerificationOutcome;
    readonly explanation: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(raw: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StructuredOutputError(`${label} output is not valid JSON`);
  }
  if (!isRecord(parsed)) {
    throw new StructuredOutputError(`${label} output must be a JSON object`);
  }
  return parsed;
}

function assertKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unexpected = Object.keys(record).find((key) => !allowed.includes(key));
  if (unexpected !== undefined) {
    throw new StructuredOutputError(`${label} contains unsupported field: ${unexpected}`);
  }
}

function text(value: unknown, label: string, maxLength = 4_000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maxLength) {
    throw new StructuredOutputError(`${label} must be a non-empty string up to ${String(maxLength)} characters`);
  }
  return value.trim();
}

function array(value: unknown, label: string, maxLength: number): readonly unknown[] {
  if (!Array.isArray(value) || value.length > maxLength) {
    throw new StructuredOutputError(`${label} must be an array with at most ${String(maxLength)} entries`);
  }
  return value;
}

function stringIds(value: unknown, label: string, allowed: ReadonlySet<string>): readonly string[] {
  const values = array(value, label, 30).map((entry) => text(entry, label, 200));
  for (const id of values) {
    if (!allowed.has(id)) {
      throw new StructuredOutputError(`${label} references unknown id: ${id}`);
    }
  }
  return [...new Set(values)];
}

function enumValue<T extends string>(
  value: unknown,
  allowed: ReadonlySet<T>,
  label: string,
): T {
  if (typeof value !== "string" || !allowed.has(value as T)) {
    throw new StructuredOutputError(`${label} has an unsupported value`);
  }
  return value as T;
}

const REQUEST_KINDS = new Set(["symbol", "references", "callers", "callees", "path", "text", "search"]);
const EXPECTATIONS = new Set(["present", "absent"] as const);

function expectation(value: unknown): "present" | "absent" {
  return enumValue(value, EXPECTATIONS, "Claim check expectation");
}

const CHECK_FIELDS: Readonly<Record<string, readonly string[]>> = {
  "symbol-exists": ["kind", "symbol", "expectation"],
  references: ["kind", "symbol", "expectation"],
  callers: ["kind", "symbol", "expectation"],
  callees: ["kind", "symbol", "expectation"],
  path: ["kind", "from", "to", "maxDepth", "expectation"],
  text: ["kind", "text", "expectation"],
};

function parseClaimCheck(value: unknown): ClaimCheck | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || typeof value["kind"] !== "string") {
    throw new StructuredOutputError("Claim check must be an object");
  }
  // A check carrying fields we cannot honor (e.g. a "path" scope on a text search) would be verified
  // differently than the model intended; drop the check and let the claim go to model verification.
  const allowed = CHECK_FIELDS[value["kind"]];
  if (allowed !== undefined && Object.keys(value).some((key) => !allowed.includes(key))) return undefined;
  switch (value["kind"]) {
    case "symbol-exists":
      assertKeys(value, ["kind", "symbol", "expectation"], "Symbol check");
      return {
        kind: "symbol-exists",
        symbol: text(value["symbol"], "Check symbol", 300),
        expectation: expectation(value["expectation"]),
      };
    case "references":
    case "callers":
    case "callees":
      assertKeys(value, ["kind", "symbol", "expectation"], "Graph check");
      return {
        kind: value["kind"],
        symbol: text(value["symbol"], "Check symbol", 300),
        expectation: expectation(value["expectation"]),
      };
    case "path": {
      assertKeys(value, ["kind", "from", "to", "maxDepth", "expectation"], "Path check");
      const maxDepth = value["maxDepth"];
      if (
        maxDepth !== undefined &&
        (typeof maxDepth !== "number" || !Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > 10)
      ) {
        throw new StructuredOutputError("Claim path maxDepth must be an integer between 1 and 10");
      }
      return {
        kind: "path",
        from: text(value["from"], "Check path source", 300),
        to: text(value["to"], "Check path target", 300),
        ...(maxDepth === undefined ? {} : { maxDepth }),
        expectation: expectation(value["expectation"]),
      };
    }
    case "text":
      assertKeys(value, ["kind", "text", "expectation"], "Text check");
      return {
        kind: "text",
        text: text(value["text"], "Check text", 1_000),
        expectation: expectation(value["expectation"]),
      };
    default:
      throw new StructuredOutputError("Claim check kind is invalid");
  }
}

const REQUEST_FIELDS: Readonly<Record<string, readonly string[]>> = {
  symbol: ["kind", "name"],
  references: ["kind", "symbol"],
  callers: ["kind", "symbol"],
  callees: ["kind", "symbol"],
  path: ["kind", "from", "to", "maxDepth"],
  text: ["kind", "text"],
  search: ["kind", "query"],
};

export function parseRetrievalRequest(input: unknown): RetrievalRequest {
  if (!isRecord(input) || typeof input["kind"] !== "string" || !REQUEST_KINDS.has(input["kind"])) {
    throw new StructuredOutputError("Retrieval request kind is invalid");
  }
  // Models without schema enforcement add fields such as a claim check's "expectation" or a "path"
  // scope. Retrieval is read-only and its results are evidence-gated, so extra fields are dropped
  // instead of failing the whole role.
  const allowed = REQUEST_FIELDS[input["kind"]] ?? [];
  const value = Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)));
  switch (value["kind"]) {
    case "symbol":
      return { kind: "symbol", name: text(value["name"], "Symbol name", 300) };
    case "references":
    case "callers":
    case "callees": {
      return { kind: value["kind"], symbol: text(value["symbol"], "Graph symbol", 300) };
    }
    case "path": {
      const maxDepth = value["maxDepth"];
      if (maxDepth !== undefined && (!Number.isInteger(maxDepth) || (maxDepth as number) < 1 || (maxDepth as number) > 10)) {
        throw new StructuredOutputError("Path maxDepth must be an integer between 1 and 10");
      }
      return {
        kind: "path",
        from: text(value["from"], "Path source", 300),
        to: text(value["to"], "Path target", 300),
        ...(maxDepth === undefined ? {} : { maxDepth: maxDepth as number }),
      };
    }
    case "text":
      return { kind: "text", text: text(value["text"], "Exact text", 1_000) };
    case "search":
      return { kind: "search", query: text(value["query"], "Search query", 1_000) };
    default:
      throw new StructuredOutputError("Retrieval request kind is invalid");
  }
}

function requests(value: unknown): readonly RetrievalRequest[] {
  // Optional follow-up: an omitted or null list means no further retrieval is needed.
  if (value === undefined || value === null) return [];
  return array(value, "retrievalRequests", 10).map(parseRetrievalRequest);
}

const UNCERTAINTIES = new Set<ClaimUncertainty>(["none", "possible", "hypothesis"]);
const CHALLENGE_TYPES = new Set<ChallengeType>([
  "insufficient-evidence",
  "contradictory-evidence",
  "missing-caller",
  "missing-lifecycle-path",
  "alternative-explanation",
  "ambiguous-symbol",
  "unsupported-causal-inference",
]);
const OUTCOMES = new Set<VerificationOutcome>(["supported", "rejected", "uncertain"]);
const METHODS = new Set<VerificationMethod>(["source", "symbol", "graph", "text", "retrieval", "model"]);

export function parseInvestigatorOutput(
  raw: string,
  allowedEvidenceIds: ReadonlySet<string>,
): InvestigatorOutput {
  const parsed = parseObject(raw, "Investigator");
  assertKeys(parsed, ["summary", "claims", "retrievalRequests"], "Investigator output");
  const claims = array(parsed["claims"], "claims", 20).map((value): ProposedClaimOutput => {
    if (!isRecord(value)) throw new StructuredOutputError("Claim must be an object");
    assertKeys(value, ["statement", "evidenceIds", "uncertainty", "check"], "Claim");
    const uncertainty = enumValue(value["uncertainty"], UNCERTAINTIES, "Claim uncertainty");
    const evidenceIds = stringIds(value["evidenceIds"], "Claim evidenceIds", allowedEvidenceIds);
    if (evidenceIds.length === 0 && uncertainty !== "hypothesis") {
      throw new StructuredOutputError("A claim without evidence must be marked hypothesis");
    }
    const check = parseClaimCheck(value["check"]);
    return {
      statement: text(value["statement"], "Claim statement"),
      evidenceIds,
      uncertainty,
      ...(check === undefined ? {} : { check }),
    };
  });
  if (claims.length === 0) throw new StructuredOutputError("Investigator must return at least one claim");
  return {
    summary: text(parsed["summary"], "Investigator summary"),
    claims,
    retrievalRequests: requests(parsed["retrievalRequests"]),
  };
}

function parseChallenge(value: unknown, claimIds: ReadonlySet<string>): ChallengeOutput {
  if (!isRecord(value)) throw new StructuredOutputError("Challenge must be an object");
  assertKeys(value, ["claimId", "type", "explanation", "retrievalRequests"], "Challenge");
  const claimId = text(value["claimId"], "Challenge claimId", 200);
  if (!claimIds.has(claimId)) throw new StructuredOutputError(`Challenge references unknown claim: ${claimId}`);
  return {
    claimId,
    type: enumValue(value["type"], CHALLENGE_TYPES, "Challenge type"),
    explanation: text(value["explanation"], "Challenge explanation"),
    retrievalRequests: requests(value["retrievalRequests"]),
  };
}

export function parseSkepticOutput(raw: string, claimIds: ReadonlySet<string>): SkepticOutput {
  const parsed = parseObject(raw, "Skeptic");
  assertKeys(parsed, ["challenges"], "Skeptic output");
  return { challenges: array(parsed["challenges"], "challenges", 20).map((value) => parseChallenge(value, claimIds)) };
}

export function parseArchitectOutput(raw: string, claimIds: ReadonlySet<string>): ArchitectOutput {
  const parsed = parseObject(raw, "Architect");
  assertKeys(parsed, ["summary", "challenges", "retrievalRequests"], "Architect output");
  let discardedItems = 0;
  const retrievalRequests = array(parsed["retrievalRequests"], "retrievalRequests", 10).flatMap((value) => {
    if (!isRecord(value)) {
      discardedItems += 1;
      return [];
    }
    try {
      const claimId = value["claimId"] === undefined ? undefined : text(value["claimId"], "Architect claimId", 200);
      if (claimId !== undefined && !claimIds.has(claimId)) {
        throw new StructuredOutputError(`Architect request references unknown claim: ${claimId}`);
      }
      return [{ ...(claimId === undefined ? {} : { claimId }), request: parseRetrievalRequest(value["request"]) }];
    } catch (error) {
      if (!(error instanceof StructuredOutputError)) throw error;
      discardedItems += 1;
      return [];
    }
  });
  const challenges = array(parsed["challenges"], "challenges", 20).flatMap((value) => {
    if (!isRecord(value)) {
      discardedItems += 1;
      return [];
    }
    try {
      return [parseChallenge({
        claimId: value["claimId"],
        type: value["type"],
        explanation: value["explanation"],
        retrievalRequests: value["retrievalRequests"],
      }, claimIds)];
    } catch (error) {
      if (!(error instanceof StructuredOutputError)) throw error;
      discardedItems += 1;
      return [];
    }
  });
  return {
    summary: text(parsed["summary"], "Architect summary"),
    challenges,
    retrievalRequests,
    discardedItems,
  };
}

export function parseVerifierOutput(
  raw: string,
  claimIds: ReadonlySet<string>,
  evidenceIds: ReadonlySet<string>,
  graphEdgeIds: ReadonlySet<string>,
): VerifierOutput {
  const parsed = parseObject(raw, "Verifier");
  assertKeys(parsed, ["decisions"], "Verifier output");
  const decisions = array(parsed["decisions"], "decisions", 30).map((value): VerifierDecisionOutput => {
    if (!isRecord(value)) throw new StructuredOutputError("Verifier decision must be an object");
    assertKeys(value, ["claimId", "outcome", "method", "explanation", "evidenceIds", "graphEdgeIds"], "Verifier decision");
    const claimId = text(value["claimId"], "Verifier claimId", 200);
    if (!claimIds.has(claimId)) throw new StructuredOutputError(`Verifier references unknown claim: ${claimId}`);
    return {
      claimId,
      outcome: enumValue(value["outcome"], OUTCOMES, "Verifier outcome"),
      method: enumValue(value["method"], METHODS, "Verifier method"),
      explanation: text(value["explanation"], "Verifier explanation"),
      evidenceIds: stringIds(value["evidenceIds"], "Verifier evidenceIds", evidenceIds),
      graphEdgeIds: stringIds(value["graphEdgeIds"], "Verifier graphEdgeIds", graphEdgeIds),
    };
  });
  return { decisions };
}

export function parseJudgeOutput(raw: string, claimIds: ReadonlySet<string>): JudgeOutput {
  const parsed = parseObject(raw, "Judge");
  assertKeys(parsed, ["decisions"], "Judge output");
  return {
    decisions: array(parsed["decisions"], "decisions", 30).map((value) => {
      if (!isRecord(value)) throw new StructuredOutputError("Judge decision must be an object");
      assertKeys(value, ["claimId", "status", "explanation"], "Judge decision");
      const claimId = text(value["claimId"], "Judge claimId", 200);
      if (!claimIds.has(claimId)) throw new StructuredOutputError(`Judge references unknown claim: ${claimId}`);
      return {
        claimId,
        status: enumValue(value["status"], OUTCOMES, "Judge status"),
        explanation: text(value["explanation"], "Judge explanation"),
      };
    }),
  };
}
