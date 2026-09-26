// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProductRunView, ProjectView, RuntimeModeView, ValidationRunView } from "../../src/web/contracts.js";
import { App } from "./app.js";

const project: ProjectView = {
  id: "demo:project", name: "auth-repository", path: "Demo repository · auth lifecycle", source: "demo", gitStatus: "demo", languages: ["typescript"], indexedFiles: 5, symbols: 6, graphNodes: 11, graphEdges: 22, updatedAt: "now",
};
const runtime: RuntimeModeView = { active: "local", available: true, provider: "ollama", model: "qwen2.5-coder:3b", baseUrl: "http://127.0.0.1:11434/v1", credentialConfigured: false, reasoningPreset: "local", message: "Local", roles: [] };
const configuredRuntime: RuntimeModeView = { active: "api", available: true, provider: "opencode-go", model: "kimi-k2.7-code", baseUrl: "https://opencode.ai/zen/go/v1", credentialConfigured: true, credentialHint: "op••••••9x7z", reasoningPreset: "free-like", message: "API", roles: [] };
const validation: ValidationRunView = {
  intent: "validate",
  verdict: "pass",
  headline: "Change is consistent with the objective",
  explanation: "Conclave found no deterministic contradiction, scope violation, or unresolved graph risk.",
  recommendation: "The change can proceed to human review with the evidence below.",
  counts: { blocking: 0, warning: 0, supportedClaims: 1, totalClaims: 1 },
  report: {
    schemaVersion: 2,
    verdict: "pass",
    summary: "PASS: 0 blocking, 0 warning; 2 impacted file(s).",
    objective: "Keep authentication after refresh.",
    changeSet: {
      source: { kind: "branch", base: "master" },
      headSha: "abc123",
      files: [{ path: "src/auth/AuthProvider.ts", status: "modified", hunks: [{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 }] }],
      collectedAt: "now",
      patchBytes: 120,
    },
    findings: [],
    escalation: { recommended: false, dimensions: [], reasons: [] },
    claims: [{
      claim: { id: "restore", statement: "bootstrapSession exists.", check: { kind: "symbol-exists", symbol: "bootstrapSession", expectation: "present" } },
      outcome: "supported",
      explanation: "The indexed project contains the claimed symbol.",
      evidence: [{ path: "src/auth/AuthProvider.ts", startLine: 5, endLine: 8, symbol: "bootstrapSession", reason: "Indexed symbol evidence" }],
    }],
    impact: {
      changedSymbols: ["bootstrapSession"],
      impactedFiles: ["src/auth/AuthProvider.ts", "src/routes/App.tsx"],
      impactedSymbols: ["App", "bootstrapSession"],
    },
    metrics: {
      filesChanged: 1,
      symbolsChanged: 1,
      impactedFiles: 2,
      impactedSymbols: 2,
      graphEdgesInspected: 12,
      deterministicChecks: 1,
      durationMs: 2,
    },
    trustBoundary: {
      deterministic: true,
      reasoningModelCalls: 0,
      repositoryScriptsExecuted: false,
      knowledge: {
        parser: "typescript",
        graph: "syntax-aware",
        embedding: { id: "local-hash", kind: "deterministic-feature-hash", remoteCalls: 0 },
      },
    },
    lineage: {
      seriesId: "series_test", reviewId: "review_test", baselineTrust: "none",
      objectiveDigest: "objective_test", contractDigest: "contract_test", diffDigest: "diff_test",
      artifactDigest: "artifact_test", reportDigest: "report_test", contractStatus: "initial",
      rebaselineRequired: false,
      contractDelta: { objectiveChanged: false, addedClaimIds: [], removedClaimIds: [], changedClaimIds: [], allowedPathPrefixesAdded: [], allowedPathPrefixesRemoved: [] },
      contractSnapshot: { allowedPathPrefixes: [], claims: [] },
    },
    findingLifecycle: { progress: "initial", current: [], resolved: [], seen: [], stagnating: [] },
    receipts: { items: [], counts: { current: 0, stale: 0, invalid: 0, failed: 0, unbound: 0 } },
    challengePlan: [],
  },
  patch: "diff --git a/src/auth/AuthProvider.ts b/src/auth/AuthProvider.ts",
  handoff: "Review the Conclave evidence before merging.",
  demo: true,
};

const run: ProductRunView = {
  intent: "investigate", status: "completed", title: "Investigated verdict", answer: "Evidence-backed diagnosis.",
  claims: [
    { id: "supported", statement: "Storage persists tokens.", status: "supported", role: "investigator", evidenceIds: ["e1"], challengeCount: 0, verificationCount: 1 },
    { id: "rejected", statement: "The token is never persisted.", status: "rejected", role: "investigator", evidenceIds: ["e1"], challengeCount: 1, verificationCount: 1 },
    { id: "uncertain", statement: "A runtime race may remain.", status: "uncertain", role: "architect", evidenceIds: [], challengeCount: 0, verificationCount: 1 },
  ],
  evidence: [{ id: "e1", path: "src/auth/AuthProvider.ts", startLine: 5, endLine: 8, symbol: "bootstrapSession", excerpt: "setSession(null);", origin: "structural-unit" }],
  trace: [], retrieval: { operations: [{ label: "graph callers", status: "executed" }], evidenceCount: 1, sourceBytes: 18, approximateTokens: 5 }, metrics: [],
  graph: { query: "bootstrapSession", status: "resolved", nodes: [], edges: [] },
};

afterEach(() => { cleanup(); window.localStorage.clear(); vi.unstubAllGlobals(); });

function mockFetch(validationResult: ValidationRunView = validation): ReturnType<typeof vi.fn> {
  const mock = vi.fn((url: string, init?: RequestInit) => {
    const body = url === "/api/runtime/models"
      ? { provider: "opencode-go", endpoint: "https://opencode.ai/zen/go/v1/models", models: ["kimi-k2.7-code", "deepseek-v4-flash"] }
      : url === "/api/runtime" && init?.method === "POST"
      ? { saved: true, credentialUpdated: true, runtime: configuredRuntime, diagnostic: { mode: "api", provider: "opencode-go", endpoint: "https://opencode.ai/zen/go/v1", modelConfigured: true, endpointReachable: true, inferenceAvailable: true, retrievalLocal: true, externalCallsDisabled: false, message: "Bounded provider inference succeeded." } }
      : url === "/api/runtime" ? runtime : url === "/api/projects/demo" ? project : url === "/api/validate" ? validationResult : url.startsWith("/api/history") ? [] : run;
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } }));
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

describe("Conclave product UI", () => {
  it("makes Validate primary and shows a decision summary before raw data", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");

    expect(screen.getByRole("heading", { name: "Review this change" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));

    expect(await screen.findByRole("region", { name: "Validation summary" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No deterministic blocker or warning found" })).toBeTruthy();
    expect(screen.getByText(/Reasoning model calls: 0/i)).toBeTruthy();
    expect(screen.getByRole("region", { name: "Still needs verification" }).textContent).toContain("runtime behavior");
    expect(screen.queryByRole("region", { name: "Raw validation report" })).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Raw report" }));
    expect(screen.getByRole("region", { name: "Raw validation report" })).toBeTruthy();
    expect(screen.getByText(/"verdict": "pass"/i)).toBeTruthy();
  });

  it("keeps the product read-only and does not expose Task Mode", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    expect(within(screen.getByRole("navigation", { name: "Workspace navigation" })).queryByRole("button", { name: "Task" })).toBeNull();
    expect(screen.queryByText(/Allow scoped file edits/i)).toBeNull();
  });

  it("shows supported, rejected, and uncertain claims without hiding disagreement", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: "Investigate" }));
    fireEvent.click(screen.getByRole("button", { name: "Run investigate" }));

    await waitFor(() => expect(screen.getByText("The token is never persisted.")).toBeTruthy());
    expect(screen.getByLabelText("rejected")).toBeTruthy();
    expect(screen.getByLabelText("uncertain")).toBeTruthy();
    const evidenceButton = screen.getAllByRole("button", { name: "Evidence" }).at(0);
    if (evidenceButton === undefined) throw new Error("Expected evidence button");
    fireEvent.click(evidenceButton);
    expect(await screen.findByText("setSession(null);")).toBeTruthy();
  });

  it("keeps graph and retrieval reachable and changes providers from labelled Settings controls", async () => {
    const fetchMock = mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: "Investigate" }));
    fireEvent.click(screen.getByRole("button", { name: "Run investigate" }));
    await screen.findByText("Evidence-backed diagnosis.");
    fireEvent.click(screen.getByRole("tab", { name: "Retrieval" }));
    expect(screen.getByText("Retrieval inspector")).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Graph" }));
    expect(screen.getByRole("region", { name: "Graph explorer" })).toBeTruthy();
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: /Settings/ }));
    expect(screen.getByRole("region", { name: "Provider and role configuration" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Conclave composer" })).toBeNull();
    const navigation = within(screen.getByRole("navigation", { name: "Workspace navigation" }));
    expect(navigation.getByRole("button", { name: /Settings/ }).getAttribute("aria-current")).toBe("page");
    expect(navigation.getByRole("button", { name: "Review" }).getAttribute("aria-current")).toBeNull();
    fireEvent.change(screen.getByLabelText("Provider"), { target: { value: "opencode-go" } });
    expect(screen.getByLabelText<HTMLInputElement>("Model").value).toBe("deepseek-v4.1-flash");
    fireEvent.change(screen.getByLabelText("API key"), { target: { value: "test-browser-key" } });
    fireEvent.click(screen.getByRole("button", { name: "Load available models" }));
    expect(await screen.findByRole("option", { name: "kimi-k2.7-code" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Model"), { target: { value: "kimi-k2.7-code" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and test" }));
    expect(await screen.findByText("Saved · inference test passed")).toBeTruthy();
    expect(screen.getAllByText("op••••••9x7z").length).toBeGreaterThan(0);
    const configurationCall = fetchMock.mock.calls.find(([url, init]) => url === "/api/runtime" && (init as RequestInit | undefined)?.method === "POST");
    const request = configurationCall?.[1] as RequestInit | undefined;
    expect(typeof request?.body).toBe("string");
    expect(JSON.parse(request?.body as string)).toEqual(expect.objectContaining({
      provider: "opencode-go",
      model: "kimi-k2.7-code",
      apiKey: "test-browser-key",
    }));
    expect(screen.getByLabelText<HTMLInputElement>("API key").value).toBe("");
  });

  it("keeps review setups simple, lets people favorite one, and applies its saved model before saving credentials", async () => {
    mockFetch();
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(within(screen.getByRole("navigation", { name: "Workspace navigation" })).getByRole("button", { name: /Settings/ }));

    expect(screen.getByRole("heading", { name: "Choose how you review" })).toBeTruthy();
    expect(screen.getByText("Recommended. The best measured cost-benefit for everyday reviews.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use Free trial" }));
    await waitFor(() => expect(screen.getByLabelText<HTMLInputElement>("Model").value).toBe("space-bunny-free"));

    fireEvent.click(screen.getByRole("button", { name: "Add Free trial favorite" }));
    expect(screen.getByRole("button", { name: "Remove Free trial favorite" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Make Free trial default" }));
    expect(screen.getByText("Default")).toBeTruthy();
    const stored = window.localStorage.getItem("conclave.councils.v1") ?? "";
    expect(stored).toContain('"activeId":"free-trial"');
    expect(stored).toContain('"defaultId":"free-trial"');
    expect(stored).toContain('"free-trial"');
  });
});

describe("decision-first review", () => {
  it("shows partial rule coverage, pending verification and working evidence navigation", async () => {
    mockFetch({ ...validation, report: { ...validation.report, schemaVersion: 3, escalation: { recommended: true, reasons: ["Exercise save and reload."], dimensions: [{ dimension: "data-integrity", coverage: "partial", reason: "Only storage key syntax was examined.", remainingQuestions: ["Exercise save and reload."], checks: [{ rule: "inconsistent-key", status: "no-finding", scope: "Storage key syntax only.", paths: ["src/store.ts"], findingIds: [] }] }] } } });
    render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByRole("region", { name: "Validation summary" });
    expect(screen.getByText("Exercise save and reload.")).toBeTruthy();
    fireEvent.click(screen.getByText("What the rules examined"));
    expect(screen.getByText(/DATA INTEGRITY · Partial coverage/)).toBeTruthy();
    expect(screen.getByText(/No finding within this rule/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Inspect reviewed diff" }));
    expect(screen.getByRole("region", { name: "Git diff" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Summary" }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare agent handoff" }));
    expect(screen.getByRole("region", { name: "Agent handoff" })).toBeTruthy();
  });
  it("shows historical coverage limitations for v2", async () => {
    mockFetch(); render(<App />);
    await screen.findByText("auth-repository");
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    await screen.findByRole("region", { name: "Validation summary" });
    expect(screen.getByRole("region", { name: "Still needs verification" }).textContent).toContain("Historical report");
    expect(screen.queryByText(/claims proved/)).toBeNull();
  });
});
