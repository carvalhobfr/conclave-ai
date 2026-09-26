import { createHash } from "node:crypto";

import type { Evidence, RetrievalResult } from "../domain/evidence.js";
import type {
  AgentRole,
  Challenge,
  Claim,
  FollowUpRetrievalResult,
  ReasoningCaseState,
  ReasoningChangeContext,
  ReasoningLimits,
  ReasoningMetrics,
  ReasoningPreset,
  ReasoningResult,
  ReasoningRetrievalRequest,
  ReasoningTraceEvent,
  ReasoningTraceEventType,
  RetrievalRequest,
  RoleUsage,
  VerificationOutcome,
  VerificationResult,
  Verdict,
} from "../domain/reasoning.js";
import { DEFAULT_REASONING_LIMITS } from "../domain/reasoning.js";
import type { CodeRetrievalService } from "../retrieval/code-retrieval-service.js";
import { approximateTokenCount } from "../retrieval/context-packer.js";
import type { AgentCallRecord, StructuredAgentRuntime } from "./agent-runtime.js";
import { AgentExecutionError } from "./agent-runtime.js";
import { DeterministicClaimVerifier, requestForClaimCheck } from "./deterministic-verifier.js";
import { routeReasoningAgents } from "./reasoning-router.js";
import {
  architectPrompt,
  investigatorPrompt,
  judgePrompt,
  skepticPrompt,
  verifierPrompt,
} from "./role-prompts.js";
import { FollowUpRetrievalExecutor, retrievalRequestKey } from "./retrieval-executor.js";
import {
  parseArchitectOutput,
  parseInvestigatorOutput,
  parseJudgeOutput,
  parseSkepticOutput,
  parseVerifierOutput,
  type ChallengeOutput,
} from "./structured-outputs.js";

export type ReasoningMode = "single-pass" | "investigator-judge" | "conclave";

export interface ReasoningEngineOptions {
  readonly retrieval: CodeRetrievalService;
  readonly runtime: StructuredAgentRuntime;
  readonly preset: ReasoningPreset;
  readonly changeContext?: ReasoningChangeContext;
  readonly limits?: ReasoningLimits;
}

function retrievalQuery(question: string, context: ReasoningChangeContext | undefined): string {
  if (context === undefined) return question;
  const symbols = context.symbols.length === 0 ? "" : `\nChanged symbols: ${context.symbols.join(", ")}`;
  const related = context.relatedSymbols.length === 0 ? "" : `\nDirectly related symbols: ${context.relatedSymbols.join(", ")}`;
  return `${question}\nCurrent Git change paths: ${context.paths.join(", ")}${symbols}${related}`;
}

function stableId(prefix: string, ...parts: readonly (string | number)[]): string {
  return `${prefix}_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24)}`;
}

function dedupeEvidence(items: readonly Evidence[]): readonly Evidence[] {
  return [...new Map(items.map((item) => [item.id, item])).values()];
}

function outcomeFor(
  claimId: string,
  verifications: readonly VerificationResult[],
  judgeStatus: VerificationOutcome | undefined,
  baselineJudge: boolean,
): VerificationOutcome {
  const relevant = verifications.filter((verification) => verification.claimId === claimId);
  if (relevant.some((verification) => verification.deterministic && verification.outcome === "rejected")) {
    return "rejected";
  }
  if (relevant.some((verification) => verification.deterministic && verification.outcome === "supported")) {
    return "supported";
  }
  if (relevant.some((verification) => verification.outcome === "rejected")) return "rejected";
  if (relevant.some((verification) => verification.outcome === "supported")) return "supported";
  if (baselineJudge && judgeStatus !== undefined) return judgeStatus;
  return judgeStatus === "rejected" ? "rejected" : "uncertain";
}

function evidenceReference(evidence: Evidence): string {
  return `${evidence.path}:${String(evidence.startLine)}-${String(evidence.endLine)}${evidence.symbol === undefined ? "" : ` — ${evidence.symbol}`}`;
}

function synthesizeAnswer(claims: readonly Claim[], evidence: readonly Evidence[]): string {
  const evidenceById = new Map(evidence.map((item) => [item.id, item]));
  const lines: string[] = [];
  const append = (label: string, selected: readonly Claim[]): void => {
    if (selected.length === 0) return;
    lines.push(`${label}:`);
    for (const claim of selected) {
      const references = claim.evidenceIds
        .map((id) => evidenceById.get(id))
        .filter((item): item is Evidence => item !== undefined)
        .map(evidenceReference);
      lines.push(`- ${claim.statement}${references.length === 0 ? "" : ` [${[...new Set(references)].join(", ")}]`}`);
    }
  };
  append("Supported", claims.filter((claim) => claim.status === "supported"));
  append("Uncertain", claims.filter((claim) => claim.status === "uncertain"));
  if (lines.length === 0) return "No claims were verified as supported.";
  return lines.join("\n");
}

function roleUsage(records: readonly AgentCallRecord[]): readonly RoleUsage[] {
  const roles: readonly AgentRole[] = ["investigator", "skeptic", "architect", "verifier", "judge"];
  return roles.map((role) => {
    const selected = records.filter((record) => record.role === role);
    return {
      role,
      providerIds: [...new Set(selected.map((record) => record.providerId))],
      modelIds: [...new Set(selected.map((record) => record.modelId))],
      calls: selected.length,
      approximateInputTokens: selected.reduce((total, record) => total + record.approximateInputTokens, 0),
      approximateOutputTokens: selected.reduce((total, record) => total + record.approximateOutputTokens, 0),
      providerReportedInputTokens: selected.reduce(
        (total, record) => total + (record.providerUsage?.inputTokens ?? 0),
        0,
      ),
      providerReportedOutputTokens: selected.reduce(
        (total, record) => total + (record.providerUsage?.outputTokens ?? 0),
        0,
      ),
      latencyMs: selected.reduce((total, record) => total + record.latencyMs, 0),
    };
  });
}

export class ReasoningEngine {
  readonly #retrieval: CodeRetrievalService;
  readonly #runtime: StructuredAgentRuntime;
  readonly #preset: ReasoningPreset;
  readonly #changeContext: ReasoningChangeContext | undefined;
  readonly #limits: ReasoningLimits;

  public constructor(options: ReasoningEngineOptions) {
    this.#retrieval = options.retrieval;
    this.#runtime = options.runtime;
    this.#preset = options.preset;
    this.#changeContext = options.changeContext;
    this.#limits = options.limits ?? DEFAULT_REASONING_LIMITS;
  }

  public async ask(question: string, mode: ReasoningMode = "conclave"): Promise<ReasoningResult> {
    const started = performance.now();
    const trace: ReasoningTraceEvent[] = [];
    const calls: AgentCallRecord[] = [];
    const agentsExecuted = new Set<AgentRole>();
    let iteration = 0;
    let terminationReason: ReasoningResult["terminationReason"] = "completed";
    const executionState = { agentFailed: false };
    const emit = (
      type: ReasoningTraceEventType,
      detail: string,
      fields: Partial<Pick<ReasoningTraceEvent, "role" | "claimId" | "requestId" | "data">> = {},
    ): void => {
      trace.push({
        sequence: trace.length + 1,
        type,
        occurredAt: new Date().toISOString(),
        iteration,
        detail,
        ...fields,
      });
    };
    emit(
      "reasoning_started",
      this.#changeContext === undefined
        ? `Started ${mode} reasoning`
        : `Started ${mode} reasoning with ${this.#changeContext.source} Git context`,
      this.#changeContext === undefined
        ? {}
        : { data: { changeContext: this.#changeContext.source, changedPaths: this.#changeContext.paths.length } },
    );

    const initialRetrieval = await this.#retrieval.retrieve(retrievalQuery(question, this.#changeContext), {
      budget: {
        graphDepth: 2,
        graphNodes: Math.min(30, this.#limits.maxEvidenceUnits * 2),
        retrievalCandidates: Math.max(20, this.#limits.maxEvidenceUnits * 2),
        finalEvidence: Math.min(10, this.#limits.maxEvidenceUnits),
        sourceBytes: 24_000,
        approximateTokens: Math.min(6_000, this.#limits.maxApproximateInputTokens),
      },
    });
    const initialContext = this.#retrieval.packContext(initialRetrieval);
    let evidence = dedupeEvidence(initialRetrieval.results.map((result) => result.evidence));
    let graphEdges = [...initialRetrieval.graphEdges];
    let claims: Claim[] = [];
    const challenges: Challenge[] = [];
    const verifications: VerificationResult[] = [];
    const retrievalRequests: ReasoningRetrievalRequest[] = [];
    const retrievalResults: FollowUpRetrievalResult[] = [];

    const executeAgent = async <T>(
      role: AgentRole,
      prompt: string,
      validate: (raw: string) => T,
    ): Promise<T | undefined> => {
      const remainingCalls = this.#limits.maxAgentCalls - calls.length;
      const estimatedInput = approximateTokenCount(Buffer.byteLength(prompt));
      const usedInput = calls.reduce((total, call) => total + call.approximateInputTokens, 0);
      if (remainingCalls < 1 || usedInput + estimatedInput > this.#limits.maxApproximateInputTokens) {
        terminationReason = "budget-exhausted";
        emit("reasoning_budget_exhausted", `Skipped ${role}: reasoning budget exhausted`, { role });
        return undefined;
      }
      agentsExecuted.add(role);
      emit("agent_started", `Started ${role}`, { role });
      try {
        const execution = await this.#runtime.execute(role, prompt, validate, remainingCalls);
        calls.push(...execution.calls);
        for (const call of execution.calls.filter((record) => record.repaired)) {
          emit("agent_output_repair_requested", `${role} structured output was repaired`, {
            role,
            data: { latencyMs: call.latencyMs },
          });
        }
        emit("agent_completed", `Completed ${role}`, {
          role,
          data: { calls: execution.calls.length },
        });
        return execution.output;
      } catch (error) {
        if (error instanceof AgentExecutionError) calls.push(...error.calls);
        executionState.agentFailed = true;
        emit("agent_completed", error instanceof Error ? error.message : `${role} failed`, { role });
        return undefined;
      }
    };

    emit("agent_selected", "Investigator is required for evidence decomposition", {
      role: "investigator",
    });
    const initialEvidenceIds = new Set(
      initialContext.evidence.flatMap((item) => item.sourceEvidenceIds),
    );
    const investigator = await executeAgent(
      "investigator",
      investigatorPrompt(question, initialContext, this.#changeContext),
      (raw) => parseInvestigatorOutput(raw, initialEvidenceIds),
    );
    if (investigator !== undefined) {
      claims = investigator.claims.map((claim, index) => {
        const id = stableId("claim", question, index, claim.statement);
        emit("claim_proposed", claim.statement, { claimId: id, role: "investigator" });
        return {
          id,
          statement: claim.statement,
          evidenceIds: claim.evidenceIds,
          challengeIds: [],
          verificationIds: [],
          status: "proposed",
          uncertainty: claim.uncertainty,
          ...(claim.check === undefined ? {} : { check: claim.check }),
          origin: { role: "investigator", iteration },
        };
      });
    }

    const selections = routeReasoningAgents(this.#preset, question, initialContext, claims).map(
      (selection) => {
        const baselineSelected =
          selection.role === "investigator" ||
          (mode === "investigator-judge" && selection.role === "judge");
        const selected =
          claims.length > 0 || selection.role === "investigator"
            ? mode === "conclave"
              ? selection.selected
              : baselineSelected
            : false;
        return selected
          ? selection
          : {
              ...selection,
              selected: false,
              reason:
                claims.length === 0 && selection.role !== "investigator"
                  ? "no valid investigator claims are available"
                  : `${mode} baseline excludes ${selection.role}`,
            };
      },
    );
    for (const selection of selections.filter((item) => item.role !== "investigator")) {
      emit(selection.selected ? "agent_selected" : "agent_skipped", selection.reason, {
        role: selection.role,
      });
    }

    if (mode === "single-pass") {
      claims = claims.map((claim) => ({ ...claim, status: "supported" }));
    }

    const requestCounts = new Map<string, number>();
    const requestByKey = new Map<string, ReasoningRetrievalRequest>();
    const enqueue = (
      request: RetrievalRequest,
      requestedBy: AgentRole,
      claimId?: string,
      challengeId?: string,
    ): string | undefined => {
      const key = retrievalRequestKey(request);
      const count = requestCounts.get(key) ?? 0;
      if (
        retrievalRequests.length >= this.#limits.maxFollowUpRequests ||
        count >= this.#limits.maxRepeatedRequestCount
      ) {
        emit("reasoning_no_progress", `Ignored repeated or over-budget retrieval request: ${key}`, {
          role: requestedBy,
          ...(claimId === undefined ? {} : { claimId }),
        });
        return requestByKey.get(key)?.id;
      }
      const id = stableId("request", question, iteration, retrievalRequests.length, key);
      const record: ReasoningRetrievalRequest = {
        id,
        request,
        requestedBy,
        ...(claimId === undefined ? {} : { claimId }),
        ...(challengeId === undefined ? {} : { challengeId }),
        iteration,
      };
      requestCounts.set(key, count + 1);
      requestByKey.set(key, record);
      retrievalRequests.push(record);
      emit("retrieval_requested", key, { role: requestedBy, requestId: id, ...(claimId === undefined ? {} : { claimId }) });
      return id;
    };

    if (mode === "conclave" && investigator !== undefined) {
      for (const request of investigator.retrievalRequests) enqueue(request, "investigator");
      for (const claim of claims) {
        if (claim.check !== undefined) enqueue(requestForClaimCheck(claim.check), "verifier", claim.id);
      }
    }

    const addChallenges = (outputs: readonly ChallengeOutput[], role: "skeptic" | "architect"): void => {
      for (const output of outputs) {
        const id = stableId("challenge", question, role, challenges.length, output.claimId, output.explanation);
        const requestIds = output.retrievalRequests
          .map((request) => enqueue(request, role, output.claimId, id))
          .filter((requestId): requestId is string => requestId !== undefined);
        challenges.push({
          id,
          claimId: output.claimId,
          type: output.type,
          explanation: output.explanation,
          retrievalRequestIds: [...new Set(requestIds)],
          origin: { role, iteration },
        });
        claims = claims.map((claim) =>
          claim.id === output.claimId
            ? { ...claim, status: "challenged", challengeIds: [...claim.challengeIds, id] }
            : claim,
        );
        emit("claim_challenged", output.explanation, { role, claimId: output.claimId });
      }
    };

    const claimIds = new Set(claims.map((claim) => claim.id));
    if (mode === "conclave" && selections.find((item) => item.role === "skeptic")?.selected === true) {
      const output = await executeAgent("skeptic", skepticPrompt(question, claims, initialContext), (raw) =>
        parseSkepticOutput(raw, claimIds),
      );
      if (output !== undefined) addChallenges(output.challenges, "skeptic");
    }
    if (mode === "conclave" && selections.find((item) => item.role === "architect")?.selected === true) {
      const output = await executeAgent("architect", architectPrompt(question, claims, initialContext), (raw) =>
        parseArchitectOutput(raw, claimIds),
      );
      if (output !== undefined) {
        if (output.discardedItems > 0) {
          emit("agent_output_sanitized", `Discarded ${String(output.discardedItems)} invalid optional architect items`, {
            role: "architect",
            data: { discardedItems: output.discardedItems },
          });
        }
        addChallenges(output.challenges, "architect");
        for (const requested of output.retrievalRequests) {
          enqueue(requested.request, "architect", requested.claimId);
        }
      }
    }

    if (mode === "conclave" && retrievalRequests.length > 0) {
      iteration += 1;
      const executor = new FollowUpRetrievalExecutor(
        this.#retrieval,
        this.#limits.maxEvidenceUnits,
        initialRetrieval.budget.graphDepth + 2,
      );
      for (const request of retrievalRequests) {
        if (iteration > this.#limits.maxRounds) {
          terminationReason = "budget-exhausted";
          emit("reasoning_budget_exhausted", "Maximum retrieval rounds reached");
          break;
        }
        const result = await executor.execute(request);
        retrievalResults.push(result);
        emit("retrieval_completed", `Completed ${retrievalRequestKey(request.request)}`, {
          role: request.requestedBy,
          requestId: request.id,
          data: { evidence: result.evidence.length, graphEdges: result.graphEdges.length },
        });
      }
      evidence = dedupeEvidence([...evidence, ...retrievalResults.flatMap((result) => result.evidence)]).slice(
        0,
        this.#limits.maxEvidenceUnits,
      );
      graphEdges = [...new Map([...graphEdges, ...retrievalResults.flatMap((result) => result.graphEdges)].map((edge) => [edge.id, edge])).values()];
      claims = claims.map((claim) => {
        const followUpEvidenceIds = retrievalRequests
          .filter((request) => request.claimId === claim.id)
          .flatMap(
            (request) =>
              retrievalResults.find((result) => result.requestId === request.id)?.evidence.map((item) => item.id) ?? [],
          );
        return { ...claim, evidenceIds: [...new Set([...claim.evidenceIds, ...followUpEvidenceIds])] };
      });
    }

    const resultByRequestId = new Map(retrievalResults.map((result) => [result.requestId, result]));
    if (mode === "conclave") {
      agentsExecuted.add("verifier");
      emit("verification_started", "Started deterministic verification", { role: "verifier" });
      const verifier = new DeterministicClaimVerifier();
      for (const claim of claims) {
        if (claim.check === undefined) continue;
        const request = requestByKey.get(retrievalRequestKey(requestForClaimCheck(claim.check)));
        const result = request === undefined ? undefined : resultByRequestId.get(request.id);
        if (result === undefined) continue;
        const verification = verifier.verifyCheck(claim, result, iteration);
        if (verification !== undefined) verifications.push(verification);
      }
      // A claim whose own deterministic check passed is not overturned by a challenge's retrieval.
      const checkSupported = new Set(
        verifications
          .filter((verification) => verification.iteration === iteration && verification.deterministic && verification.outcome === "supported")
          .map((verification) => verification.claimId),
      );
      for (const challenge of challenges) {
        const claim = claims.find((item) => item.id === challenge.claimId);
        if (claim === undefined || checkSupported.has(claim.id)) continue;
        for (const requestId of challenge.retrievalRequestIds) {
          const result = resultByRequestId.get(requestId);
          if (result === undefined) continue;
          const verification = verifier.verifyChallenge(claim, challenge, result, iteration);
          if (verification !== undefined) verifications.push(verification);
        }
      }

      const deterministicallyResolved = new Set(
        verifications.filter((verification) => verification.deterministic).map((verification) => verification.claimId),
      );
      const unresolvedClaims = claims.filter((claim) => !deterministicallyResolved.has(claim.id));
      if (unresolvedClaims.length > 0) {
        const packedResults: RetrievalResult[] = evidence.map((item, index) => ({
          evidence: item,
          rank: index + 1,
          score: 1 / (index + 1),
          signals: {},
          reasons: [{ strategy: "graph", detail: "reasoning evidence" }],
        }));
        const context = this.#retrieval.packResults(packedResults, graphEdges, initialRetrieval.budget);
        const allEvidenceIds = new Set(evidence.map((item) => item.id));
        const edgeIds = new Set(graphEdges.map((edge) => edge.id));
        const output = await executeAgent(
          "verifier",
          verifierPrompt(question, unresolvedClaims, challenges, verifications, context),
          (raw) => parseVerifierOutput(raw, new Set(unresolvedClaims.map((claim) => claim.id)), allEvidenceIds, edgeIds),
        );
        if (output !== undefined) {
          for (const decision of output.decisions) {
            verifications.push({
              id: stableId("verification", decision.claimId, iteration, decision.outcome, decision.explanation),
              claimId: decision.claimId,
              outcome: decision.outcome,
              method: decision.method,
              explanation: decision.explanation,
              evidenceIds: decision.evidenceIds,
              graphEdgeIds: decision.graphEdgeIds,
              deterministic: false,
              iteration,
            });
          }
        }
      } else {
        emit("agent_completed", "Verifier completed using deterministic operations", { role: "verifier" });
      }
    }

    let judgeStatuses = new Map<string, VerificationOutcome>();
    if (mode !== "single-pass" && claims.length > 0) {
      emit("judge_started", "Started final adjudication", { role: "judge" });
      const output = await executeAgent("judge", judgePrompt(question, claims, challenges, verifications, evidence), (raw) =>
        parseJudgeOutput(raw, claimIds),
      );
      if (output !== undefined) judgeStatuses = new Map(output.decisions.map((decision) => [decision.claimId, decision.status]));
    }

    if (mode !== "single-pass") {
      claims = claims.map((claim) => {
        const relevant = verifications.filter((verification) => verification.claimId === claim.id);
        const status = outcomeFor(
          claim.id,
          verifications,
          judgeStatuses.get(claim.id),
          mode === "investigator-judge",
        );
        emit(`claim_${status}` as ReasoningTraceEventType, `${claim.statement}: ${status}`, { claimId: claim.id });
        return {
          ...claim,
          status,
          evidenceIds: [...new Set([...claim.evidenceIds, ...relevant.flatMap((verification) => verification.evidenceIds)])],
          verificationIds: relevant.map((verification) => verification.id),
        };
      });
    }

    const verdictEvidenceIds = new Set(
      claims.filter((claim) => claim.status !== "rejected").flatMap((claim) => claim.evidenceIds),
    );
    const verdictEvidence = evidence.filter((item) => verdictEvidenceIds.has(item.id));
    const verdict: Verdict = {
      answer: synthesizeAnswer(claims, verdictEvidence),
      claims: {
        supported: claims.filter((claim) => claim.status === "supported"),
        rejected: claims.filter((claim) => claim.status === "rejected"),
        uncertain: claims.filter((claim) => claim.status === "uncertain"),
      },
      evidence: verdictEvidence,
      traceSummary: {
        agentsExecuted: [...agentsExecuted],
        agentsSkipped: selections.filter((selection) => !selection.selected),
        retrievalRounds: retrievalResults.length > 0 ? iteration : 0,
        modelCalls: calls.length,
      },
    };
    emit("verdict_completed", "Completed evidence-grounded verdict", {
      data: {
        supported: verdict.claims.supported.length,
        rejected: verdict.claims.rejected.length,
        uncertain: verdict.claims.uncertain.length,
      },
    });
    if (executionState.agentFailed && terminationReason === "completed") terminationReason = "agent-failure";

    const usage = roleUsage(calls);
    const metrics: ReasoningMetrics = {
      modelCalls: calls.length,
      retrievalRounds: verdict.traceSummary.retrievalRounds,
      followUpRequests: retrievalRequests.length,
      deterministicOperations: retrievalResults.reduce(
        (total, result) => total + result.deterministicOperations.length,
        0,
      ),
      evidenceCount: evidence.length,
      approximateInputTokens: usage.reduce((total, item) => total + item.approximateInputTokens, 0),
      approximateOutputTokens: usage.reduce((total, item) => total + item.approximateOutputTokens, 0),
      providerReportedInputTokens: usage.reduce((total, item) => total + item.providerReportedInputTokens, 0),
      providerReportedOutputTokens: usage.reduce((total, item) => total + item.providerReportedOutputTokens, 0),
      latencyMs: Math.max(0, performance.now() - started),
      roleUsage: usage,
      finalClaims: {
        supported: verdict.claims.supported.length,
        rejected: verdict.claims.rejected.length,
        uncertain: verdict.claims.uncertain.length,
      },
    };
    const state: ReasoningCaseState = {
      question,
      ...(this.#changeContext === undefined ? {} : { changeContext: this.#changeContext }),
      iteration,
      initialRetrieval,
      initialContext,
      claims,
      challenges,
      verifications,
      retrievalRequests,
      retrievalResults,
      evidence,
      graphEdges,
      selections,
    };
    return { verdict, state, trace, metrics, terminationReason };
  }
}
