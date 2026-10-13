import { loadReasoningConfiguration } from "../config/reasoning-config.js";
import { loadRuntimeConfig } from "../config/runtime-config.js";
import type { SemanticBudget, SemanticPipeline } from "../domain/audit.js";
import { createRoleProviders } from "../providers/provider-factory.js";
import { EnvironmentCredentialSource } from "../storage/environment-credential-source.js";
import { DEFAULT_SEMANTIC_BUDGET, modelFamily, type SemanticAuditOptions } from "./semantic-discovery.js";

/** What a person asked for. Everything else comes from the provider configuration. */
export interface SemanticRequest {
  readonly budget: Partial<SemanticBudget>;
  readonly discoveryModel?: string;
  /** Smart pipeline: the model that verifies each hypothesis. */
  readonly verifierModel?: string;
  /** Challenge hypotheses with the five reasoning roles instead of one verifier. */
  readonly deep: boolean;
  /** US dollars per million tokens, as stated by the operator. */
  readonly pricing?: { readonly inputPerMillionTokens: number; readonly outputPerMillionTokens: number };
}

/** What will be called and where source will go, shown to the person before any model call. */
export interface SemanticDisclosure {
  readonly pipeline: SemanticPipeline;
  readonly discovery: { readonly providerId: string; readonly modelId: string };
  /** Smart pipeline only. */
  readonly verifier?: { readonly providerId: string; readonly modelId: string; readonly independent: boolean; readonly sameModelFamily: boolean };
  /** Deep pipeline only: `provider/model` of every role. */
  readonly challengeRoles: readonly string[];
  readonly privacyBoundary: "local-only" | "external";
  /** Host of the provider endpoint, when external. Never a credential. */
  readonly providerHost?: string;
  readonly budget: SemanticBudget;
}

export interface SemanticSetup {
  readonly options: Omit<SemanticAuditOptions, "onProgress">;
  readonly disclosure: SemanticDisclosure;
}

/**
 * Turns a request into provider wiring, from the configuration Ask and Investigate use. The
 * discovery model is the request's, else CONCLAVE_DISCOVERY_MODEL, else the Investigator's, and
 * always runs on the Investigator's provider. The verifier is the request's, else
 * CONCLAVE_SEMANTIC_VERIFIER_MODEL, else the Verifier role's model.
 *
 * @throws when no provider or model is configured.
 */
export function resolveSemanticSetup(request: SemanticRequest, environment: NodeJS.ProcessEnv = process.env): SemanticSetup {
  const runtime = loadRuntimeConfig(environment);
  const reasoning = loadReasoningConfiguration(runtime, environment);
  const providers = createRoleProviders(runtime, reasoning.assignments, new EnvironmentCredentialSource(environment));
  const investigator = reasoning.assignments.find((assignment) => assignment.role === "investigator");
  if (investigator === undefined) throw new Error("No investigator model is configured");
  const configured = environment["CONCLAVE_DISCOVERY_MODEL"]?.trim();
  const modelId = request.discoveryModel ?? (configured === undefined || configured === "" ? investigator.modelId : configured);
  const verifierRole = reasoning.assignments.find((assignment) => assignment.role === "verifier") ?? investigator;
  const requested = request.verifierModel ?? (environment["CONCLAVE_SEMANTIC_VERIFIER_MODEL"]?.trim() || undefined);
  const verifier = requested !== undefined
    ? { providerId: investigator.providerId, modelId: requested }
    : { providerId: verifierRole.providerId, modelId: verifierRole.modelId, ...(verifierRole.fallbackModelId === undefined ? {} : { fallbackModelId: verifierRole.fallbackModelId }) };
  const pipeline: SemanticPipeline = request.deep ? "deep" : "smart";
  return {
    options: {
      providers,
      assignments: reasoning.assignments,
      discovery: { providerId: investigator.providerId, modelId, ...(investigator.fallbackModelId === undefined ? {} : { fallbackModelId: investigator.fallbackModelId }) },
      preset: reasoning.preset,
      pipeline,
      verifier,
      privacyBoundary: runtime.privacyBoundary,
      budget: request.budget,
      ...(request.pricing === undefined ? {} : { pricing: request.pricing }),
    },
    disclosure: {
      pipeline,
      discovery: { providerId: investigator.providerId, modelId },
      ...(pipeline === "smart" ? { verifier: { providerId: verifier.providerId, modelId: verifier.modelId, independent: verifier.providerId !== investigator.providerId || verifier.modelId !== modelId, sameModelFamily: modelFamily(verifier.modelId) === modelFamily(modelId) } } : {}),
      challengeRoles: pipeline === "deep" ? [...new Set(reasoning.assignments.map((assignment) => `${assignment.providerId}/${assignment.modelId}`))] : [],
      privacyBoundary: runtime.privacyBoundary,
      ...(runtime.privacyBoundary === "external" && runtime.providerSelection.baseUrl !== undefined ? { providerHost: new URL(runtime.providerSelection.baseUrl).host } : {}),
      budget: { ...DEFAULT_SEMANTIC_BUDGET, ...request.budget },
    },
  };
}
