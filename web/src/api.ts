import type { FindingFeedback } from "../../src/storage/finding-feedback.js";
import type { SavedAcceptanceContract } from "../../src/storage/acceptance-contract.js";
import type { ValidationContract } from "../../src/domain/validation.js";
import type {
  GraphView,
  ProductRunView,
  ProjectView,
  ReviewHistoryView,
  RuntimeConfigurationRequest,
  RuntimeConfigurationResult,
  RuntimeModelDiscoveryRequest,
  RuntimeModelsView,
  RuntimeModeView,
  ValidationRequestView,
  ValidationRunView,
} from "../../src/web/contracts.js";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const payload: unknown = await response.json();
  if (!response.ok) {
    const error = payload as { error?: { message?: string } };
    throw new Error(error.error?.message ?? "Conclave request failed.");
  }
  return payload as T;
}

function json(value: unknown): RequestInit {
  return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) };
}

function contractValue(contractText: string): unknown {
  try {
    return JSON.parse(contractText);
  } catch {
    throw new Error("The optional validation contract must be valid JSON.");
  }
}

export const api = {
  feedback: (projectId: string): Promise<readonly FindingFeedback[]> => request(`/api/feedback?projectId=${encodeURIComponent(projectId)}`),
  saveFeedback: (projectId: string, reviewId: string, feedback: Pick<FindingFeedback, "fingerprint" | "classification" | "note">): Promise<FindingFeedback> => request("/api/feedback", json({ projectId, reviewId, feedback })),
  acceptance: (projectId: string): Promise<SavedAcceptanceContract | null> => request(`/api/acceptance?projectId=${encodeURIComponent(projectId)}`),
  saveAcceptance: (projectId: string, contract: ValidationContract, revision: string | null): Promise<SavedAcceptanceContract> => request("/api/acceptance", json({ projectId, contract, revision })),
  runtime: (): Promise<RuntimeModeView> => request("/api/runtime"),
  configureRuntime: (configuration: RuntimeConfigurationRequest): Promise<RuntimeConfigurationResult> => request("/api/runtime", json(configuration)),
  discoverModels: (configuration: RuntimeModelDiscoveryRequest): Promise<RuntimeModelsView> => request("/api/runtime/models", json(configuration)),
  demo: (): Promise<ProjectView> => request("/api/projects/demo", json({})),
  open: (path: string): Promise<ProjectView> => request("/api/projects/open", json({ path })),
  validate: (
    projectId: string,
    source: ValidationRequestView["source"],
    objective: string,
    contractText: string,
    previousReviewId?: string,
    receipts?: unknown,
  ): Promise<ValidationRunView> => {
    const payload: ValidationRequestView = contractText.trim() === ""
      ? { projectId, source, objective }
      : { projectId, source, objective, contract: contractValue(contractText) };
    return request("/api/validate", json({ ...payload, previousReviewId, receipts }));
  },
  run: (projectId: string, intent: "ask" | "investigate", query: string): Promise<ProductRunView> => request("/api/run", json({ projectId, intent, query })),
  graph: (projectId: string, symbol: string): Promise<GraphView> => request(`/api/graph?projectId=${encodeURIComponent(projectId)}&symbol=${encodeURIComponent(symbol)}`),
  history: (projectId: string): Promise<readonly ReviewHistoryView[]> => request(`/api/history?projectId=${encodeURIComponent(projectId)}`),
};
