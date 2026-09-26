import { createHash } from "node:crypto";

import type {
  Challenge,
  Claim,
  ClaimCheck,
  FollowUpRetrievalResult,
  RetrievalRequest,
  VerificationMethod,
  VerificationResult,
} from "../domain/reasoning.js";

export function requestForClaimCheck(check: ClaimCheck): RetrievalRequest {
  switch (check.kind) {
    case "symbol-exists":
      return { kind: "symbol", name: check.symbol };
    case "references":
    case "callers":
    case "callees":
      return { kind: check.kind, symbol: check.symbol };
    case "path":
      return {
        kind: "path",
        from: check.from,
        to: check.to,
        ...(check.maxDepth === undefined ? {} : { maxDepth: check.maxDepth }),
      };
    case "text":
      return { kind: "text", text: check.text };
  }
}

function verificationId(claimId: string, iteration: number, basis: string): string {
  return `verification_${createHash("sha256")
    .update(`${claimId}\0${String(iteration)}\0${basis}`)
    .digest("hex")
    .slice(0, 24)}`;
}

function methodFor(check: ClaimCheck): VerificationMethod {
  switch (check.kind) {
    case "symbol-exists":
      return "symbol";
    case "text":
      return "text";
    case "callers":
    case "callees":
    case "references":
    case "path":
      return "graph";
  }
}

function hasResult(result: FollowUpRetrievalResult): boolean {
  return result.evidence.length > 0 || result.graphEdges.length > 0;
}

export class DeterministicClaimVerifier {
  public verifyCheck(
    claim: Claim,
    result: FollowUpRetrievalResult,
    iteration: number,
  ): VerificationResult | undefined {
    const check = claim.check;
    if (check === undefined) return undefined;
    const unresolved = result.deterministicOperations.find(
      (operation) => operation === "ambiguous-symbol" || operation === "unresolved-symbol",
    );
    if (unresolved !== undefined) {
      return {
        id: verificationId(claim.id, iteration, `check:${check.kind}:${unresolved}`),
        claimId: claim.id,
        outcome: "uncertain",
        method: methodFor(check),
        explanation: `${check.kind} could not be verified because deterministic resolution was ${unresolved}`,
        evidenceIds: result.evidence.map((evidence) => evidence.id),
        graphEdgeIds: result.graphEdges.map((edge) => edge.id),
        deterministic: true,
        iteration,
      };
    }
    const found = hasResult(result);
    const expectedPresent = check.expectation === "present";
    const supported = found === expectedPresent;
    return {
      id: verificationId(claim.id, iteration, `check:${check.kind}:${String(found)}`),
      claimId: claim.id,
      outcome: supported ? "supported" : "rejected",
      method: methodFor(check),
      explanation: `${check.kind} expected ${check.expectation}; deterministic retrieval ${found ? "found matching evidence" : "found no matching evidence"}`,
      evidenceIds: result.evidence.map((evidence) => evidence.id),
      graphEdgeIds: result.graphEdges.map((edge) => edge.id),
      deterministic: true,
      iteration,
    };
  }

  public verifyChallenge(
    claim: Claim,
    challenge: Challenge,
    result: FollowUpRetrievalResult,
    iteration: number,
  ): VerificationResult | undefined {
    if (challenge.type !== "contradictory-evidence") return undefined;
    // Retrieval that only returns what the claim already cites cannot contradict it.
    const cited = new Set(claim.evidenceIds);
    const newEvidence = result.evidence.filter((evidence) => !cited.has(evidence.id));
    if (newEvidence.length === 0 && result.graphEdges.length === 0) return undefined;
    return {
      id: verificationId(claim.id, iteration, `challenge:${challenge.id}:${result.requestId}`),
      claimId: claim.id,
      outcome: "rejected",
      method: result.graphEdges.length > 0 ? "graph" : "retrieval",
      explanation: `Follow-up retrieval for challenge ${challenge.id} found contradictory repository evidence`,
      evidenceIds: newEvidence.map((evidence) => evidence.id),
      graphEdgeIds: result.graphEdges.map((edge) => edge.id),
      deterministic: true,
      iteration,
    };
  }
}
