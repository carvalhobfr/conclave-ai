// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AuditReport } from "../../../src/domain/audit.js";
import type { IssueProposal } from "../../../src/domain/issue-proposal.js";
import type { AuditJobView, AuditPreflightView, ProjectView } from "../../../src/web/contracts.js";
import type { FindingView, ProposalDetail } from "../../../src/workflow/triage-service.js";
import { Cockpit } from "./cockpit.js";
import type { CockpitSection } from "./overview.js";

const project: ProjectView = { id: "local:repo", name: "shop", path: "/work/shop", source: "local", gitStatus: "unknown", languages: ["typescript"], indexedFiles: 12, symbols: 40, graphNodes: 52, graphEdges: 90, updatedAt: "2026-10-12T10:00:00.000Z" };
const RUN = { runId: "audit_run_1", snapshot: "snapshot_aaaaaaaaaaaaaaaa", at: "2026-10-12T10:00:00.000Z" };

function finding(overrides: Partial<FindingView> & Pick<FindingView, "id" | "title">): FindingView {
  return {
    fingerprint: overrides.id, aliases: [], ruleId: "discarded-error", category: "reliability", severity: "medium", explanation: "An empty catch block discards the error.", remediation: "Handle or rethrow.",
    location: { path: "src/session.ts", startLine: 3, symbol: "load" }, evidence: [{ path: "src/session.ts", startLine: 3, endLine: 3, reason: "empty catch" }], limitations: ["The rule reads syntax only."], evidenceDigest: "evidence_1",
    state: "new", firstSeen: RUN, lastSeen: RUN, lastEvaluated: RUN, timesSeen: 1, transitions: [], suppressed: false, baselined: false, disposition: { classification: "unreviewed" }, proposals: [], issueEligibility: { eligible: true },
    ...overrides,
  };
}

function hypothesis(id: string, title: string, status: "model-supported" | "model-disputed" | "inconclusive", extra: Partial<NonNullable<FindingView["hypothesis"]>> = {}, explanation?: string): FindingView {
  return finding({
    id, title, ruleId: "semantic-discovery", origin: "ai-hypothesis", category: "correctness", severity: "high", location: { path: "src/pagination.ts", startLine: 3, symbol: "paginate" },
    limitations: ["Proposed by a language model from the source it was shown. No rule matched and nothing was executed, so the behavior was not observed."],
    hypothesis: {
      providerId: "opencode-go", modelId: "deepseek-v4.1-flash", defectClass: "boundary", confidence: "high", trigger: "page 1 is requested", consequence: "the first page is skipped", triggerKind: "normal-use", grounding: "quote-located",
      review: { status, modelCalls: 1, detail: "A model judgement.", ...(explanation === undefined ? {} : { explanation }), verifier: { providerId: "opencode-go", modelId: "deepseek-v4.1-flash", independent: false, sameModelFamily: true } },
      ...extra,
    },
  });
}

const FINDINGS: readonly FindingView[] = [
  finding({ id: "audit_finding_rule0001", title: "Empty catch block" }),
  hypothesis("audit_finding_supp0001", "Pagination starts one page late", "model-supported", {}, "Offset is page * size."),
  hypothesis("audit_finding_disp0001", "Cache is never invalidated", "model-disputed", {}, "updateUser deletes the entry before returning."),
  hypothesis("audit_finding_inco0001", "Non-numeric page becomes NaN", "inconclusive", { triggerKind: "invalid-input", reachability: "unproven", review: { status: "inconclusive", modelCalls: 2, detail: "Verification failed, so the hypothesis was not verified: verifier provider failed" } }),
];

const REPORT = {
  schemaVersion: 1, kind: "repository-audit", repository: { id: "r", name: "shop" }, snapshot: { id: "snapshot_aaaaaaaaaaaaaaaa", kind: "working-tree", headCommit: "0123456789abcdef" }, generatedAt: "2026-10-12T10:00:00.000Z",
  coverage: { status: "partial", accounting: { filesDiscovered: 14, filesAnalyzed: 10, eligibleSourceFiles: 11, ignoredDirectories: 1, filesNotAnalyzed: { ignored: 2, safetyExcluded: 1, unsupported: 1, parserFailure: 0, unexamined: 0 } }, limits: ["Rules read syntax and the import graph."] },
  metrics: { rulesExecuted: 6, rulesSkipped: 0, symbols: 40, graphEdges: 90, totalMs: 120 },
  semantic: {
    pipeline: "smart", discovery: { providerId: "opencode-go", modelId: "deepseek-v4.1-flash" }, verifier: { providerId: "opencode-go", modelId: "deepseek-v4.1-flash", independent: false, sameModelFamily: true }, investigation: [], privacyBoundary: "external",
    budget: { maxModelCalls: 40, maxInputTokens: 200000, maxOutputTokens: 40000, maxDurationMs: 900000, maxRegions: 30, maxInvestigations: 10 }, stoppedBy: "regions",
    usage: { modelCalls: 9, failedCalls: 1, approximateInputTokens: 12000, approximateOutputTokens: 900, providerReportedInputTokens: 13000, providerReportedOutputTokens: 950, durationMs: 31000, byStage: [], cost: { status: "not-priced" } },
    coverage: { eligibleFiles: 10, filesExamined: 4, filesPartiallyExamined: 0, filesNotExamined: 6, filesInvestigated: 2, eligibleLines: 1000, linesExamined: 400, regionsPlanned: 10, regionsByState: { examined: 4, "examined-cached": 0, "not-examined-budget": 6, "not-examined-failed": 0, "not-examined-withheld": 0 }, regions: [{ path: "src/pagination.ts", startLine: 1, endLine: 9, state: "examined" }], regionsOmitted: 0, complete: false },
    hypotheses: { proposed: 4, ungrounded: 1, duplicates: 0, coveredByRule: 0, reachabilityUnproven: 1, rejectedByReview: 1, verificationFailed: 1, recorded: 3, byReview: { "not-reviewed": 0, "model-supported": 1, inconclusive: 1, "model-disputed": 1 } },
    dismissed: [], dismissedOmitted: 0, limits: ["Every hypothesis is a language model's reading of source text."],
  },
} as unknown as AuditReport;

const INJECTED_BODY = "## What the model proposed\n<img src=x onerror=\"window.pwned = true\"> [click](javascript:alert(1))";

function proposal(status: IssueProposal["status"], revision: string): IssueProposal {
  return {
    schemaVersion: 1, id: "proposal_abcdef12", attempt: 1, repository: { id: "r", name: "shop" }, findings: [{ id: "audit_finding_supp0001", fingerprint: "audit_finding_supp0001", evidenceDigest: "evidence_1" }],
    source: { runId: "audit_run_1", snapshot: "snapshot_aaaaaaaaaaaaaaaa", analyzerVersion: "0.19.0" }, title: "[Unconfirmed] Pagination starts one page late", body: INJECTED_BODY, labels: ["conclave-audit", "ai-hypothesis"],
    severity: "high", category: "correctness", ruleId: "semantic-discovery", evidence: [], reproduction: "not-attempted", humanDisposition: "unreviewed", hypothesis: true, coverageLimitations: [], status, revision, generatedRevision: "rev_generated",
    invalidatedApprovals: [], createdAt: "2026-10-12T10:05:00.000Z", updatedAt: "2026-10-12T10:05:00.000Z", history: [{ at: "2026-10-12T10:05:00.000Z", action: "created", to: "draft" }],
  };
}

interface Server {
  findings: readonly FindingView[];
  proposals: IssueProposal[];
  preflight: AuditPreflightView;
  job: AuditJobView | null;
  readonly posts: { readonly url: string; readonly body: Record<string, unknown> }[];
  /** Overrides the response to one POST path. */
  readonly failures: Map<string, string>;
}

function serve(initial: Partial<Server> = {}): Server {
  const server: Server = {
    findings: FINDINGS, proposals: [], job: null, posts: [], failures: new Map(),
    preflight: { mode: "smart", available: true, cachedRegions: 3, disclosure: { pipeline: "smart", discovery: { providerId: "opencode-go", modelId: "deepseek-v4.1-flash" }, verifier: { providerId: "opencode-go", modelId: "deepseek-v4.1-flash", independent: false, sameModelFamily: true }, challengeRoles: [], privacyBoundary: "external", providerHost: "opencode.ai", budget: { maxModelCalls: 40, maxInputTokens: 200000, maxOutputTokens: 40000, maxDurationMs: 900000, maxRegions: 30, maxInvestigations: 10 } } },
    ...initial,
  };
  const detail = (): ProposalDetail => ({ proposal: server.proposals[0] as IssueProposal, gate: { publishable: false, blockers: ["The proposal is not approved"] } });
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => {
    const path = url.split("?")[0] ?? url;
    const body = init?.body === undefined ? {} : JSON.parse(init.body as string) as Record<string, unknown>;
    if (init?.method === "POST") server.posts.push({ url: path, body });
    const failure = server.failures.get(path);
    if (failure !== undefined) return Promise.resolve(new Response(JSON.stringify({ error: { message: failure } }), { status: 400 }));
    let payload: unknown;
    if (path === "/api/audit/latest") payload = { report: REPORT };
    else if (path === "/api/audit/runs") payload = [{ id: "audit_run_1", snapshot: "snapshot_aaaaaaaaaaaaaaaa", at: "2026-10-12T10:00:00.000Z", analyzerVersion: "0.19.0", coverageStatus: "partial", filesDiscovered: 14, filesAnalyzed: 10, rulesExecuted: [], findingsObserved: 4, byState: { new: 4, persistent: 0, resolved: 0, reappeared: 0, "not-evaluated": 0 } }];
    else if (path === "/api/audit/status") payload = { job: server.job };
    else if (path === "/api/audit/preflight") payload = url.includes("mode=static") ? { mode: "static", available: true, cachedRegions: 3 } : server.preflight;
    else if (path === "/api/audit/start") { server.job = { id: "job1", mode: body["mode"] as AuditJobView["mode"], state: "running", startedAt: "2026-10-12T11:00:00.000Z", progress: ["Indexing and running rules"] }; payload = server.job; }
    else if (path === "/api/findings") payload = server.findings;
    else if (path === "/api/findings/detail") { const id = new URL(url, "http://x").searchParams.get("id"); payload = { finding: server.findings.find((item) => item.id === id), feedback: [], proposals: server.proposals, source: [{ path: "src/pagination.ts", startLine: 3, endLine: 3, reason: "quoted line", lines: [{ number: 2, text: "export function paginate(items, page) {" }, { number: 3, text: "  const start = page * size; // <script>alert(1)</script>" }] }] }; }
    else if (path === "/api/findings/classify") { server.findings = server.findings.map((item) => item.id === body["id"] ? { ...item, disposition: { classification: body["classification"] as FindingView["disposition"]["classification"], classifiedAt: "2026-10-12T12:00:00.000Z" } } : item); payload = server.findings[0]; }
    else if (path === "/api/issues") payload = server.proposals;
    else if (path === "/api/issues/detail") payload = detail();
    else if (path === "/api/issues/propose") { server.proposals = [proposal("draft", "rev_draft_0000000001")]; payload = { proposal: server.proposals[0], created: true }; }
    else if (path === "/api/issues/edit") { server.proposals = [{ ...(server.proposals[0] as IssueProposal), title: body["title"] as string, revision: "rev_edited_000000002" }]; payload = detail(); }
    else if (path === "/api/issues/submit") { server.proposals = [{ ...(server.proposals[0] as IssueProposal), status: "pending-review" }]; payload = detail(); }
    else if (path === "/api/issues/approve") { server.proposals = [{ ...(server.proposals[0] as IssueProposal), status: "approved", approval: { revision: body["revision"] as string, evidence: {}, approvedAt: "2026-10-12T12:30:00.000Z", approvedBy: { kind: "api", name: "cockpit" }, method: "api-revision" } }]; payload = detail(); }
    else if (path === "/api/issues/reject") { server.proposals = [{ ...(server.proposals[0] as IssueProposal), status: "rejected", rejection: { reason: body["reason"] as string, at: "2026-10-12T12:40:00.000Z", by: { kind: "api" }, revision: "r", evidence: {} } }]; payload = detail(); }
    else if (path === "/api/issues/refresh") { server.proposals = [{ ...(server.proposals[0] as IssueProposal), status: "draft", revision: "rev_refreshed_00003" }]; payload = detail(); }
    else payload = {};
    return Promise.resolve(new Response(JSON.stringify(payload), { status: 200 }));
  }));
  return server;
}

function Harness({ start }: { readonly start: CockpitSection }) {
  const [section, setSection] = useState<CockpitSection>(start);
  return <><output aria-label="section">{section}</output><Cockpit project={project} section={section} onNavigate={setSection} /></>;
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("repository overview", () => {
  it("shows rule coverage and AI coverage separately and never calls the repository verified", async () => {
    serve();
    render(<Harness start="overview" />);

    const rules = await screen.findByRole("region", { name: "Deterministic coverage" });
    expect(rules.textContent).toContain("10 / 11");
    const ai = screen.getByRole("region", { name: "AI coverage" });
    expect(ai.textContent).toContain("400 / 1,000");
    expect(ai.textContent).toContain("partial");
    expect(ai.textContent).toContain("was not shown to be correct");
    expect(screen.getByRole("region", { name: "AI hypotheses by verification" }).textContent).toContain("Model-supported is not confirmed");
    const usage = screen.getByRole("region", { name: "Model usage and budget" });
    expect(usage.textContent).toContain("9 / 40");
    expect(usage.textContent).toContain("Not computed: no price was supplied");
    expect(usage.textContent).toContain("The regions budget. Coverage is incomplete.");
    expect(document.body.textContent).not.toMatch(/bug[- ]free|no bugs|fully verified|100% (accurate|coverage)/iu);
  });
});

describe("findings inbox", () => {
  it("tells the two origins apart, keeps disputed hypotheses visible and filters by verification", async () => {
    serve();
    render(<Harness start="findings" />);

    const table = await screen.findByRole("table", { name: "Findings" });
    expect(within(table).getAllByText("AI hypothesis")).toHaveLength(3);
    expect(within(table).getAllByText("Static finding")).toHaveLength(1);
    expect(within(table).getByText("Model-disputed")).toBeTruthy();
    expect(within(table).queryByText(/confirmed defect|verified/iu)).toBeNull();
    // Supported hypotheses lead, disputed ones come last, none is dropped.
    const titles = within(table).getAllByRole("row").slice(1).map((row) => row.textContent);
    expect(titles.findIndex((text) => text.includes("Pagination starts"))).toBeLessThan(titles.findIndex((text) => text.includes("Cache is never invalidated")));

    fireEvent.change(screen.getByLabelText("Verification"), { target: { value: "model-disputed" } });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Cache is never invalidated")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Verification"), { target: { value: "all" } });
    fireEvent.change(screen.getByLabelText("Search"), { target: { value: "session" } });
    expect(within(table).getAllByRole("row")).toHaveLength(2);
    expect(within(table).getByText("Empty catch block")).toBeTruthy();
  });

  it("shows the contradiction behind a disputed hypothesis and what remains unestablished", async () => {
    serve();
    render(<Harness start="findings" />);
    fireEvent.click(await screen.findByRole("button", { name: "Cache is never invalidated" }));

    const contradiction = await screen.findByRole("region", { name: "Contradictory evidence" });
    expect(contradiction.textContent).toContain("updateUser deletes the entry before returning.");
    expect(contradiction.textContent).toContain("does not show the code is correct");
    const ladder = screen.getByRole("region", { name: "What is established" });
    expect(ladder.textContent).toContain("Static rule matchNo.");
    expect(ladder.textContent).toContain("Reproduced defectNo.");
    expect(ladder.textContent).toContain("Confirming a finding does not approve an issue");
    expect(screen.getByRole("region", { name: "Verification" }).textContent).toContain("the same model as discovery: a second reading, not an independent check");
    expect(screen.getByRole("region", { name: "Investigation coverage" }).textContent).toContain("read by the discovery model in the last audit");
    // Repository source is text, never markup.
    await screen.findByText(/const start = page \* size;/u);
    expect(document.querySelector("script")).toBeNull();
  });

  it("presents a failed verification as inconclusive and unproven reachability as unproven", async () => {
    serve();
    render(<Harness start="findings" />);
    fireEvent.click(await screen.findByRole("button", { name: "Non-numeric page becomes NaN" }));

    const verification = await screen.findByRole("region", { name: "Verification" });
    expect(within(verification).getByText("Inconclusive")).toBeTruthy();
    expect(verification.textContent).toContain("Verification failed, so the hypothesis was not verified");
    expect(screen.getByRole("region", { name: "Unverified assumptions" }).textContent).toContain("Reachability is unproven. It was not shown to be unreachable.");
    expect(screen.getByRole("region", { name: "Contradictory evidence" }).textContent).toContain("None recorded");
  });

  it("records a classification without approving anything, and requires a note to dismiss", async () => {
    const server = serve();
    render(<Harness start="findings" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pagination starts one page late" }));
    await screen.findByRole("region", { name: "Classify finding" });

    expect((screen.getByRole("button", { name: "Mark false positive" })).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(server.posts.some((post) => post.url === "/api/findings/classify")).toBe(true));
    expect(server.posts.find((post) => post.url === "/api/findings/classify")?.body).toEqual({ projectId: "local:repo", id: "audit_finding_supp0001", classification: "confirmed" });
    await waitFor(() => expect(screen.getByRole("region", { name: "What is established" }).textContent).toContain("Confirmed by a person"));
    expect(server.posts.some((post) => post.url.startsWith("/api/issues/"))).toBe(false);
    expect(screen.getByRole("region", { name: "What is established" }).textContent).toContain("Human issue approvalNone.");
  });
});

describe("detail panel", () => {
  it("closes, gives the table its columns back and returns focus to the row it was opened from", async () => {
    serve();
    render(<Harness start="findings" />);
    const table = await screen.findByRole("table", { name: "Findings" });
    const row = within(table).getAllByRole("button")[0];
    if (row === undefined) throw new Error("Expected a finding row");

    fireEvent.click(row);
    const panel = await screen.findByRole("complementary", { name: "Finding detail" });
    expect(table.classList.contains("compact")).toBe(true);
    expect(row.closest("tr")?.getAttribute("aria-current")).toBe("true");

    fireEvent.click(within(panel).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Finding detail" })).toBeNull();
    expect(table.classList.contains("compact")).toBe(false);
    expect(row.closest("tr")?.getAttribute("aria-current")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(row));
  });
});

describe("issue proposal review", () => {
  it("walks create, edit, submit and explicit approval of the exact revision shown", async () => {
    const server = serve();
    render(<Harness start="findings" />);
    fireEvent.click(await screen.findByRole("button", { name: "Pagination starts one page late" }));
    fireEvent.click(await screen.findByRole("button", { name: "Create issue proposal" }));

    await waitFor(() => expect(screen.getByLabelText("section").textContent).toBe("proposals"));
    const title = await screen.findByLabelText("Title");
    // Markdown from the proposal is shown as source text; nothing in it becomes an element.
    expect(screen.getByDisplayValue(/<img src=x onerror=/u)).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    expect(document.querySelector("a[href^='javascript']")).toBeNull();

    fireEvent.change(title, { target: { value: "Pagination skips the first page" } });
    expect((screen.getByRole("button", { name: "Submit for review" })).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save edits" }));
    await waitFor(() => expect(screen.getByLabelText("Current revision").textContent).toBe("rev_edited_000000002"));
    fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));

    const approve = await screen.findByRole("button", { name: "Approve this revision" });
    expect(approve.hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(approve);
    await waitFor(() => expect(server.posts.some((post) => post.url === "/api/issues/approve")).toBe(true));
    expect(server.posts.find((post) => post.url === "/api/issues/approve")?.body).toEqual({ projectId: "local:repo", id: "proposal_abcdef12", revision: "rev_edited_000000002" });
    expect((await screen.findByRole("region", { name: "Review actions" })).textContent).toContain("Approved");
    expect(screen.getByRole("region", { name: "Publication requirements" }).textContent).toContain("This release publishes nothing.");
    expect(screen.queryByRole("button", { name: /publish/iu })).toBeNull();
  });

  it("surfaces a stale revision instead of approving it, and supports refresh and rejection", async () => {
    const server = serve({ proposals: [proposal("pending-review", "rev_pending_00000001")] });
    server.failures.set("/api/issues/approve", "Approval names revision rev_pending_00000001, but the proposal is at rev_other. Review the current text and approve that revision.");
    render(<Harness start="proposals" />);
    fireEvent.click(await screen.findByRole("button", { name: "[Unconfirmed] Pagination starts one page late" }));
    fireEvent.click(await screen.findByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Approve this revision" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Review the current text and approve that revision");

    server.failures.clear();
    server.proposals = [{ ...proposal("stale", "rev_pending_00000001"), stale: { reason: "The source behind this proposal changed.", at: "2026-10-12T13:00:00.000Z", previousStatus: "approved" } }];
    cleanup();
    render(<Harness start="proposals" />);
    fireEvent.click(await screen.findByRole("button", { name: "[Unconfirmed] Pagination starts one page late" }));
    expect((await screen.findByText(/Any earlier approval is void/u)).textContent).toContain("The source behind this proposal changed.");

    // A stored reason without its full stop still reads as two sentences.
    server.proposals = [{ ...proposal("stale", "rev_pending_00000001"), stale: { reason: "Finding audit_1 was resolved", at: "2026-10-12T13:00:00.000Z", previousStatus: "approved" } }];
    cleanup();
    render(<Harness start="proposals" />);
    fireEvent.click(await screen.findByRole("button", { name: "[Unconfirmed] Pagination starts one page late" }));
    expect((await screen.findByText(/Any earlier approval is void/u)).textContent).toContain("Finding audit_1 was resolved. Any earlier approval is void.");
    server.proposals = [{ ...proposal("stale", "rev_pending_00000001"), stale: { reason: "The source behind this proposal changed.", at: "2026-10-12T13:00:00.000Z", previousStatus: "approved" } }];
    cleanup();
    render(<Harness start="proposals" />);
    fireEvent.click(await screen.findByRole("button", { name: "[Unconfirmed] Pagination starts one page late" }));
    await screen.findByText(/Any earlier approval is void/u);
    expect(screen.queryByRole("button", { name: "Approve this revision" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Refresh from the current finding" }));
    await waitFor(() => expect(screen.getByLabelText("Current revision").textContent).toBe("rev_refreshed_00003"));

    const reject = screen.getByRole("button", { name: "Reject proposal" });
    expect(reject.hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for rejecting"), { target: { value: "Pages are zero-based here" } });
    fireEvent.click(reject);
    await waitFor(() => expect(server.posts.find((post) => post.url === "/api/issues/reject")?.body["reason"]).toBe("Pages are zero-based here"));
  });
});

describe("audit controls", () => {
  it("starts a static audit without any consent step", async () => {
    const server = serve();
    render(<Harness start="audits" />);
    fireEvent.click(await screen.findByRole("button", { name: "Start Static audit" }));

    await waitFor(() => expect(server.posts.find((post) => post.url === "/api/audit/start")?.body).toEqual({ projectId: "local:repo", mode: "static", acknowledgedModelCalls: false, budget: {} }));
    expect((await screen.findByRole("region", { name: "Audit run status" })).textContent).toContain("running");
  });

  it("is one tab stop whose arrow keys move the mode, and a moved mode still needs consent", async () => {
    const server = serve();
    render(<Harness start="audits" />);
    const group = await screen.findByRole("radiogroup", { name: "Audit mode" });
    const tabStops = (): string[] => within(group).getAllByRole("radio").filter((radio) => radio.tabIndex === 0).map((radio) => radio.querySelector("strong")?.textContent ?? "");
    expect(tabStops()).toEqual(["Static"]);

    fireEvent.keyDown(within(group).getByRole("radio", { checked: true }), { key: "ArrowRight" });
    expect(within(group).getByRole("radio", { checked: true }).textContent).toContain("Smart");
    expect(tabStops()).toEqual(["Smart"]);
    expect(document.activeElement).toBe(within(group).getByRole("radio", { checked: true }));
    expect((await screen.findByRole("button", { name: "Start Smart audit" })).hasAttribute("disabled")).toBe(true);

    fireEvent.keyDown(within(group).getByRole("radio", { checked: true }), { key: "ArrowLeft" });
    fireEvent.keyDown(within(group).getByRole("radio", { checked: true }), { key: "ArrowUp" });
    expect(within(group).getByRole("radio", { checked: true }).textContent).toContain("Deep");
    expect(server.posts.some((post) => post.url === "/api/audit/start")).toBe(false);
  });

  it("discloses the remote provider and stays disabled until the person confirms", async () => {
    const server = serve();
    render(<Harness start="audits" />);
    fireEvent.click(await screen.findByRole("radio", { name: /^Smart/u }));

    const disclosure = await screen.findByRole("region", { name: "What this audit will send and call" });
    expect(disclosure.textContent).toContain("A remote provider (opencode.ai) will receive sanitized repository code.");
    expect(disclosure.textContent).toContain("not guaranteed to catch every secret");
    expect(disclosure.textContent).toContain("the same model as discovery");
    expect(disclosure.textContent).toContain("3 region result(s) are cached");
    const start = screen.getByRole("button", { name: "Start Smart audit" });
    expect(start.hasAttribute("disabled")).toBe(true);
    expect(server.posts).toEqual([]);

    fireEvent.change(screen.getByLabelText(/Max model calls/u), { target: { value: "12" } });
    const consent = await screen.findByRole("checkbox");
    fireEvent.click(consent);
    fireEvent.click(screen.getByRole("button", { name: "Start Smart audit" }));
    await waitFor(() => expect(server.posts.find((post) => post.url === "/api/audit/start")?.body).toEqual({ projectId: "local:repo", mode: "smart", acknowledgedModelCalls: true, budget: { maxModelCalls: 12 } }));
  });

  it("explains an unavailable provider and a failed run, with incomplete coverage of the last audit", async () => {
    serve({ preflight: { mode: "deep", available: false, reason: "CONCLAVE_API_KEY is required for api mode", cachedRegions: 0 }, job: { id: "job0", mode: "smart", state: "failed", startedAt: "2026-10-12T09:00:00.000Z", finishedAt: "2026-10-12T09:01:00.000Z", progress: ["discovery 1: src/a.ts:1-40"], error: "Go usage limit exceeded" } });
    render(<Harness start="audits" />);

    expect((await screen.findByRole("region", { name: "Audit run status" })).textContent).toContain("Go usage limit exceeded");
    expect(screen.getByRole("region", { name: "AI coverage" }).textContent).toContain("6 not reached");
    expect(screen.getByRole("region", { name: "AI coverage" }).textContent).toContain("Run the same audit again to continue");
    fireEvent.click(screen.getByRole("radio", { name: /^Deep/u }));
    expect((await screen.findByText(/cannot run as configured/u)).parentElement?.textContent).toContain("CONCLAVE_API_KEY is required");
    expect((screen.getByRole("button", { name: "Start Deep audit" })).hasAttribute("disabled")).toBe(true);
  });
});
