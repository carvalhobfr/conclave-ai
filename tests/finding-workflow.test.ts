import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";

import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { APPLICABILITY_FILENAME, BASELINE_FILENAME, parseApplicability } from "../src/analysis/audit-policy.js";
import { auditIndexWithEvaluation, auditRepository, auditRepositoryWithLedger } from "../src/analysis/repository-audit.js";
import { REPOSITORY_RULES } from "../src/analysis/rules.js";
import { auditExitCode } from "../src/cli-audit.js";
import { findingsCommand, issuesCommand } from "../src/cli-triage.js";
import type { AuditFinding, AuditReport } from "../src/domain/audit.js";
import type { FindingLedger, LedgerFinding } from "../src/domain/finding-ledger.js";
import type { IssueProposal, IssueProposalStore } from "../src/domain/issue-proposal.js";
import { check } from "../src/lib.js";
import { listFindingFeedback } from "../src/storage/finding-feedback.js";
import { loadFindingLedger, loadIssueProposals, saveFindingLedger } from "../src/storage/finding-ledger.js";
import { createDeterministicValidationIndex } from "../src/validation/deterministic-index.js";
import { reconcileLedger } from "../src/validation/finding-lifecycle.js";
import { proposalRevision, publicationGate } from "../src/validation/issue-proposal.js";
import { TriageService, type FindingView } from "../src/workflow/triage-service.js";

const roots: string[] = [];
const ACTOR = { kind: "cli", name: "tester" } as const;

// Assembled at run time so this file does not itself match a credential detector.
const SLACK_SHAPED = ["xoxb", "123456789012", "abcdefghijklmnopqrstuvwx"].join("-");

afterAll(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function put(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), content);
  }
}

async function repository(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "conclave-workflow-"));
  roots.push(root);
  await put(root, files);
  return root;
}

const SESSION = [
  "export function load() {",
  "  try { read(); } catch {}",
  "}",
  "export function save() {",
  "  try { write(); } catch {}",
  "  try { write(); } catch {}",
  "}",
  "",
].join("\n");
const SESSION_FIXED = SESSION.replace("  try { read(); } catch {}", "  try { read(); } catch (error) { report(error); }");
const LISTEN = "export function watch() {\n  window.addEventListener(\"resize\", onResize);\n}\n";
const FILES = { "src/session.ts": SESSION, "src/listen.ts": LISTEN, "src/clean.ts": "export const one = 1;\n" };
const CYCLE = {
  "src/a.ts": "import { b } from \"./b.js\";\nexport const a = () => b;\n",
  "src/b.ts": "import { a } from \"./a.js\";\nexport const b = () => a;\n",
};

async function run(root: string, options: Parameters<typeof auditRepositoryWithLedger>[1] = {}): Promise<{ readonly report: AuditReport; readonly ledger: FindingLedger }> {
  const result = await auditRepositoryWithLedger(root, { write: true, ...options });
  if (result.ledger === undefined) throw new Error("Expected the audit to be recorded");
  return { report: result.report, ledger: result.ledger };
}

function states(ledger: FindingLedger): readonly string[] {
  return Object.values(ledger.findings).map((finding) => `${finding.location.path}:${String(finding.location.startLine)} ${finding.state}`).sort();
}

function at(ledger: FindingLedger, path: string, line: number): LedgerFinding {
  const found = Object.values(ledger.findings).find((finding) => finding.location.path === path && finding.location.startLine === line);
  if (found === undefined) throw new Error(`No finding at ${path}:${String(line)}`);
  return found;
}

async function listing(root: string): Promise<readonly string[]> {
  return (await readdir(root, { recursive: true })).sort();
}

describe("finding ledger lifecycle", () => {
  it("records each finding once however many times the same snapshot is audited", async () => {
    const root = await repository(FILES);
    const first = await run(root);
    const second = await run(root);
    const third = await run(root);

    expect(first.report.findings).toHaveLength(4);
    expect(Object.keys(third.ledger.findings)).toHaveLength(4);
    expect(new Set(Object.values(third.ledger.findings).map((finding) => finding.id)).size).toBe(4);
    expect(third.ledger.runs).toHaveLength(3);
    expect(new Set(third.ledger.runs.map((item) => item.snapshot)).size).toBe(1);
    expect(second.ledger.repository.id).toBe(first.report.repository.id);
  });

  it("marks first observations new and unchanged ones persistent, keeping where they were first seen", async () => {
    const root = await repository(FILES);
    const first = await run(root);
    expect(Object.values(first.ledger.findings).every((finding) => finding.state === "new" && finding.timesSeen === 1)).toBe(true);
    expect(first.ledger.runs[0]?.byState).toEqual({ new: 4, persistent: 0, resolved: 0, reappeared: 0, "not-evaluated": 0 });

    const second = await run(root);
    const firstRun = first.ledger.runs[0]?.id;
    for (const finding of Object.values(second.ledger.findings)) {
      expect(finding.state).toBe("persistent");
      expect(finding.firstSeen.runId).toBe(firstRun);
      expect(finding.lastSeen.runId).toBe(second.ledger.runs[0]?.id);
      expect(finding.timesSeen).toBe(2);
    }
  });

  it("resolves a finding the audit examined and no longer observes, and links a reintroduction to its history", async () => {
    const root = await repository(FILES);
    const first = await run(root);
    const original = at(first.ledger, "src/session.ts", 2);

    await put(root, { "src/session.ts": SESSION_FIXED });
    const fixed = await run(root);
    const resolved = fixed.ledger.findings[original.fingerprint];
    expect(resolved?.state).toBe("resolved");
    expect(resolved?.resolvedAt?.runId).toBe(fixed.ledger.runs[0]?.id);
    expect(resolved?.lastSeen.runId).toBe(first.ledger.runs[0]?.id);
    expect(states(fixed.ledger).filter((item) => item.endsWith("persistent"))).toHaveLength(3);

    // Still resolved after another audit; a resolved finding is not re-resolved or forgotten.
    expect((await run(root)).ledger.findings[original.fingerprint]?.state).toBe("resolved");

    await put(root, { "src/session.ts": SESSION });
    const back = await run(root);
    const reappeared = back.ledger.findings[original.fingerprint];
    expect(reappeared?.state).toBe("reappeared");
    expect(reappeared?.id).toBe(original.id);
    expect(reappeared?.firstSeen).toEqual(original.firstSeen);
    expect(reappeared?.resolvedAt?.runId).toBe(fixed.ledger.runs[0]?.id);
    expect(reappeared?.transitions.map((item) => item.to)).toEqual(["new", "resolved", "reappeared"]);
    expect(Object.keys(back.ledger.findings)).toHaveLength(4);
    expect((await run(root)).ledger.findings[original.fingerprint]?.state).toBe("persistent");
  });

  it("never resolves a finding whose file or rule the audit did not cover", async () => {
    const root = await repository(FILES);
    const first = await run(root);
    const listener = at(first.ledger, "src/listen.ts", 2);

    // The file is still there and still has the problem; it is only ignored now.
    await put(root, { ".conclaveignore": "src/listen.ts\n" });
    const ignored = (await run(root)).ledger.findings[listener.fingerprint];
    expect(ignored?.state).toBe("not-evaluated");
    expect(ignored?.notEvaluatedReason).toContain("src/listen.ts was not analyzed in this audit (ignored)");
    expect(ignored?.resolvedAt).toBeUndefined();
    expect(ignored?.lastEvaluated.runId).toBe(first.ledger.runs[0]?.id);

    // An ignored directory is recorded once; files below it are covered by that entry.
    await put(root, { ".conclaveignore": "src/\n" });
    const directory = await run(root);
    expect(Object.values(directory.ledger.findings).map((finding) => finding.state)).toEqual(["not-evaluated", "not-evaluated", "not-evaluated", "not-evaluated"]);

    await unlink(join(root, ".conclaveignore"));
    expect((await run(root)).ledger.findings[listener.fingerprint]?.state).toBe("persistent");

    // A rule that did not run establishes nothing about its findings.
    const partial = await run(root, { rules: REPOSITORY_RULES.filter((rule) => rule.id !== "unreleased-resource") });
    expect(partial.ledger.findings[listener.fingerprint]?.state).toBe("not-evaluated");
    expect(partial.ledger.findings[listener.fingerprint]?.notEvaluatedReason).toBe("Rule unreleased-resource did not run in this audit");

    // A file withheld for safety was not read, so nothing about it is known.
    await put(root, { "src/listen.ts": `${LISTEN}export const token = "${["sk", "synthetic0workflow0secret0value0"].join("-")}";\n` });
    const withheld = await run(root);
    expect(withheld.ledger.findings[listener.fingerprint]?.state).toBe("not-evaluated");
    expect(withheld.ledger.findings[listener.fingerprint]?.notEvaluatedReason).toContain("safety-excluded-content");

    // Deleting the file is positive evidence: the code is gone.
    await unlink(join(root, "src/listen.ts"));
    expect((await run(root)).ledger.findings[listener.fingerprint]?.state).toBe("resolved");
  });

  it("keeps distinct findings in one file distinct", async () => {
    const root = await repository(FILES);
    const { ledger } = await run(root);
    const session = Object.values(ledger.findings).filter((finding) => finding.location.path === "src/session.ts");

    expect(session.map((finding) => finding.location.startLine)).toEqual(expect.arrayContaining([2, 5, 6]));
    expect(new Set(session.map((finding) => finding.fingerprint)).size).toBe(3);

    // Removing one of two identical statements resolves exactly one of them.
    await put(root, { "src/session.ts": SESSION.replace("  try { write(); } catch {}\n  try { write(); } catch {}\n", "  try { write(); } catch {}\n") });
    const after = (await run(root)).ledger;
    expect(Object.values(after.findings).filter((finding) => finding.location.path === "src/session.ts").map((finding) => finding.state).sort()).toEqual(["persistent", "persistent", "resolved"]);
  });

  it("migrates an old identity to at most one current finding", async () => {
    const root = await repository(FILES);
    const { index } = await createDeterministicValidationIndex(root);
    const { report, evaluation } = auditIndexWithEvaluation({ index, analyzerVersion: "0.0.0" });
    const [first, second] = report.findings.filter((finding) => finding.location.path === "src/session.ts") as [AuditFinding, AuditFinding];
    // A ledger written under an older identity scheme knew one finding, by a fingerprint no current finding has.
    const legacy = "audit_00000000000000000000";
    const old = reconcileLedger(undefined, { ...report, generatedAt: "2026-01-01T00:00:00.000Z", findings: [{ ...first, fingerprint: legacy, id: "audit_finding_old" }] }, evaluation).ledger;
    const classified: FindingLedger = { ...old, findings: { [legacy]: { ...(old.findings[legacy] as LedgerFinding), disposition: { classification: "accepted-risk", note: "Known" } } } };

    // Both current findings claim the same old identity.
    const migrated = reconcileLedger(classified, report, evaluation, { migrations: new Map([[first.fingerprint, legacy], [second.fingerprint, legacy]]) }).ledger;

    expect(migrated.findings[legacy]).toBeUndefined();
    expect(migrated.findings[first.fingerprint]).toEqual(expect.objectContaining({ state: "persistent", aliases: [legacy], disposition: { classification: "accepted-risk", note: "Known" } }));
    expect(migrated.findings[first.fingerprint]?.firstSeen.at).toBe("2026-01-01T00:00:00.000Z");
    expect(migrated.findings[second.fingerprint]).toEqual(expect.objectContaining({ state: "new", aliases: [], disposition: { classification: "unreviewed" } }));

    // An old fingerprint that is still a current finding is never handed to another one.
    const kept = reconcileLedger(reconcileLedger(undefined, report, evaluation).ledger, report, evaluation, { migrations: new Map([[second.fingerprint, first.fingerprint]]) }).ledger;
    expect(kept.findings[first.fingerprint]?.aliases).toEqual([]);
    expect(kept.findings[second.fingerprint]?.aliases).toEqual([]);
  });

  it("keeps human classifications across audits, resolution and reappearance", async () => {
    const root = await repository(FILES);
    const first = await run(root);
    const target = at(first.ledger, "src/session.ts", 2);
    const triage = await TriageService.open(root);
    await triage.classifyFinding(target.id, { classification: "accepted-risk", note: "Reading is best effort", actor: ACTOR });

    await run(root);
    await put(root, { "src/session.ts": SESSION_FIXED });
    expect((await run(root)).ledger.findings[target.fingerprint]).toEqual(expect.objectContaining({ state: "resolved", disposition: expect.objectContaining({ classification: "accepted-risk", note: "Reading is best effort" }) as unknown }));
    await put(root, { "src/session.ts": SESSION });
    expect((await run(root)).ledger.findings[target.fingerprint]).toEqual(expect.objectContaining({ state: "reappeared", disposition: expect.objectContaining({ classification: "accepted-risk" }) as unknown }));
  });
});

describe("ledger storage", () => {
  it("survives an interrupted or damaged write without losing classifications", async () => {
    const root = await repository(FILES);
    const first = await run(root);
    const target = at(first.ledger, "src/listen.ts", 2);
    await (await TriageService.open(root)).classifyFinding(target.id, { classification: "confirmed", actor: ACTOR });
    await run(root);
    const path = join(root, ".conclave", "findings", "ledger.json");

    // A write cut short leaves a temporary file beside the ledger; it is never read.
    await writeFile(`${path}.tmp-interrupted`, "{ \"schemaVersion\": 1, \"findings\": {");
    expect((await loadFindingLedger(root)).recovered).toBe(false);

    // A ledger that no longer parses falls back to the version before the last write.
    await writeFile(path, "{ \"schemaVersion\": 1, \"findings\": {");
    const recovered = await loadFindingLedger(root);
    expect(recovered.recovered).toBe(true);
    expect(recovered.value?.findings[target.fingerprint]?.disposition.classification).toBe("confirmed");

    // The next audit rewrites a healthy ledger from it.
    const healed = await run(root);
    expect(healed.ledger.findings[target.fingerprint]?.disposition.classification).toBe("confirmed");
    expect((await loadFindingLedger(root)).recovered).toBe(false);

    // With no readable version at all the state is refused, never replaced by an empty one.
    await writeFile(path, "not json");
    await writeFile(`${path}.bak`, "not json either");
    await expect(loadFindingLedger(root)).rejects.toThrow(/corrupt and no readable previous version/u);
    await expect(run(root)).rejects.toThrow(/corrupt/u);
    expect(await readFile(path, "utf8")).toBe("not json");
  });

  it("rebuilds classifications from the feedback log when the ledger is lost", async () => {
    const root = await repository(FILES);
    const target = at((await run(root)).ledger, "src/listen.ts", 2);
    await (await TriageService.open(root)).classifyFinding(target.id, { classification: "false-positive", note: "Listener lives for the page lifetime", actor: ACTOR });

    await rm(join(root, ".conclave", "findings"), { recursive: true });
    const rebuilt = (await run(root)).ledger.findings[target.fingerprint];
    expect(rebuilt?.state).toBe("new");
    expect(rebuilt?.disposition).toEqual(expect.objectContaining({ classification: "false-positive", note: "Listener lives for the page lifetime" }));
  });

  it("refuses a ledger written by a newer schema instead of overwriting it", async () => {
    const root = await repository(FILES);
    const { ledger } = await run(root);
    const path = join(root, ".conclave", "findings", "ledger.json");
    const future = JSON.stringify({ ...ledger, schemaVersion: 2 });
    await writeFile(path, future);

    await expect(run(root)).rejects.toThrow(/written by a newer Conclave/u);
    expect(await readFile(path, "utf8")).toBe(future);
  });

  it("drops a long-resolved finding nobody classified and keeps a classified one", async () => {
    const root = await repository(FILES);
    const first = await run(root);
    const kept = at(first.ledger, "src/session.ts", 2);
    const dropped = at(first.ledger, "src/listen.ts", 2);
    await (await TriageService.open(root)).classifyFinding(kept.id, { classification: "confirmed", actor: ACTOR });
    await put(root, { "src/session.ts": SESSION_FIXED, "src/listen.ts": "export const none = 0;\n" });
    const resolved = (await run(root)).ledger;
    expect([resolved.findings[kept.fingerprint]?.state, resolved.findings[dropped.fingerprint]?.state]).toEqual(["resolved", "resolved"]);

    // Age both resolutions past the retention window.
    const long = "2020-01-01T00:00:00.000Z";
    const aged = Object.fromEntries(Object.entries(resolved.findings).map(([key, finding]) => [key, finding.resolvedAt === undefined ? finding : { ...finding, resolvedAt: { ...finding.resolvedAt, at: long } }]));
    await saveFindingLedger(root, { ...resolved, findings: aged });
    const later = (await run(root)).ledger;
    expect(later.findings[dropped.fingerprint]).toBeUndefined();
    expect(later.findings[kept.fingerprint]?.disposition.classification).toBe("confirmed");
  });

  it("persists nothing for an audit that was not asked to write", async () => {
    const root = await repository(FILES);
    const before = await listing(root);

    await auditRepository(root);
    await auditRepositoryWithLedger(root, { write: false });
    const triage = await TriageService.open(root);
    expect(await triage.listFindings()).toEqual([]);
    expect(await triage.listAuditRuns()).toEqual([]);
    expect(await triage.listProposals()).toEqual([]);
    // Commands that need a recorded audit fail, and failing creates nothing either.
    await expect(triage.classifyFinding("abcdef", { classification: "confirmed", actor: ACTOR })).rejects.toThrow(/No audit has been recorded/u);
    await expect(triage.createProposal("abcdef", { actor: ACTOR })).rejects.toThrow(/No audit has been recorded/u);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await findingsCommand(["list", "--repo", root]);
    await issuesCommand(["list", "--repo", root]);
    expect(log.mock.calls.flat().join("\n")).toContain("No findings recorded");

    expect(await listing(root)).toEqual(before);
    expect(existsSync(join(root, ".conclave"))).toBe(false);
  });
});

describe("baseline and applicability", () => {
  it("keeps baselined findings visible, stops them failing the run, and still fails on a new one", async () => {
    const root = await repository(FILES);
    const options = { failOn: "medium", requireComplete: false } as const;
    expect(auditExitCode((await run(root)).report, options)).toBe(1);

    const written = await auditRepositoryWithLedger(root, { write: true, updateBaseline: true });
    expect(written.baselineWritten).toBe(BASELINE_FILENAME);
    const baseline = JSON.parse(await readFile(join(root, BASELINE_FILENAME), "utf8")) as { readonly findings: readonly Record<string, string>[] };
    expect(baseline.findings).toHaveLength(4);
    // Fingerprints, rule ids and paths only.
    expect(Object.keys(baseline.findings[0] ?? {}).sort()).toEqual(["fingerprint", "path", "ruleId"]);

    const baselined = await run(root);
    expect(baselined.report.summary).toEqual(expect.objectContaining({ findings: 4, baselined: 4, exempt: 0, gated: 0 }));
    expect(baselined.report.findings.every((finding) => finding.baseline !== undefined)).toBe(true);
    expect(auditExitCode(baselined.report, options)).toBe(0);
    // A baseline is not a judgement: nothing was classified.
    expect(Object.values(baselined.ledger.findings).every((finding) => finding.baselined && finding.disposition.classification === "unreviewed")).toBe(true);

    await put(root, { "src/added.ts": "export function later() {\n  try { go(); } catch {}\n}\n" });
    const grown = await run(root);
    expect(grown.report.summary).toEqual(expect.objectContaining({ findings: 5, baselined: 4, gated: 1 }));
    expect(grown.report.findings.filter((finding) => finding.baseline === undefined).map((finding) => finding.location.path)).toEqual(["src/added.ts"]);
    expect(auditExitCode(grown.report, options)).toBe(1);
    const triage = await TriageService.open(root);
    expect((await triage.listFindings({ baselined: false })).map((finding) => finding.location.path)).toEqual(["src/added.ts"]);
    expect(await triage.listFindings({ baselined: true })).toHaveLength(4);

    // The baseline can be set aside for one run.
    expect((await auditRepository(root, { baseline: false })).summary.baselined).toBe(0);
  });

  it("keeps a declared fixture visible and ineligible for proposals without touching other test code", async () => {
    const root = await repository({
      "tests/fixtures/broken.ts": "export const broken = ;\n",
      "tests/helper.ts": "export function quiet() {\n  try { go(); } catch {}\n}\n",
      [APPLICABILITY_FILENAME]: JSON.stringify({ schemaVersion: 1, applicability: [{ paths: ["tests/fixtures/"], rules: ["parser-diagnostic"], role: "fixture", reason: "Deliberately invalid parser input", gate: false }] }),
    });
    const { report, ledger } = await run(root);
    const fixture = report.findings.find((finding) => finding.location.path === "tests/fixtures/broken.ts");
    const helper = report.findings.find((finding) => finding.location.path === "tests/helper.ts");

    // Visible and counted; only its consequences are declared.
    expect(fixture?.applicability).toEqual({ role: "fixture", issueProposals: false, gate: false, reason: "Deliberately invalid parser input", source: `${APPLICABILITY_FILENAME}#0` });
    expect(report.summary).toEqual(expect.objectContaining({ findings: 2, exempt: 1, gated: 1 }));
    expect(report.policy.applicability).toEqual({ path: APPLICABILITY_FILENAME, declarations: 1, matched: 1 });
    // Test code outside the declaration is audited like any other code.
    expect(helper?.applicability).toBeUndefined();
    expect(auditExitCode(report, { failOn: "high", requireComplete: false })).toBe(0);
    expect(auditExitCode(report, { failOn: "medium", requireComplete: false })).toBe(1);

    const triage = await TriageService.open(root);
    const views = await triage.listFindings();
    expect(views.find((view) => view.location.path === "tests/fixtures/broken.ts")?.issueEligibility).toEqual({ eligible: false, reason: `Declared as fixture in ${APPLICABILITY_FILENAME}#0: Deliberately invalid parser input` });
    await expect(triage.createProposal(at(ledger, "tests/fixtures/broken.ts", 1).id, { actor: ACTOR })).rejects.toThrow(/Declared as fixture/u);
    expect((await triage.createProposal(at(ledger, "tests/helper.ts", 2).id, { actor: ACTOR })).created).toBe(true);
  });

  it("rejects a declaration that is malformed or that covers the whole repository", async () => {
    const declaration = (extra: object): unknown => ({ schemaVersion: 1, applicability: [{ paths: ["tests/fixtures/"], role: "fixture", reason: "Fixtures", ...extra }] });
    expect(parseApplicability(declaration({}))).toEqual([{ paths: ["tests/fixtures/"], role: "fixture", reason: "Fixtures", issueProposals: false, gate: true }]);
    for (const paths of [["**"], ["*"], ["/"], ["**/*"], ["!src/"]]) expect(() => parseApplicability(declaration({ paths }))).toThrow();
    expect(() => parseApplicability(declaration({ reason: "" }))).toThrow(/reason/u);
    expect(() => parseApplicability(declaration({ run: "rm -rf ." }))).toThrow(/unsupported field/u);
    expect(() => parseApplicability(declaration({ gate: "no" }))).toThrow(/gate/u);

    // An unreadable policy fails the audit; it is never skipped silently.
    const root = await repository({ ...FILES, [APPLICABILITY_FILENAME]: "{ not json" });
    await expect(auditRepository(root)).rejects.toThrow(/not valid JSON/u);
  });
});

async function proposalFor(root: string, path: string, line: number): Promise<{ readonly triage: TriageService; readonly finding: LedgerFinding; readonly proposal: IssueProposal }> {
  const { ledger } = await run(root);
  const finding = at(ledger, path, line);
  const triage = await TriageService.open(root);
  const { proposal } = await triage.createProposal(finding.id, { actor: ACTOR });
  return { triage, finding, proposal };
}

describe("triage and issue proposals", () => {
  it("keeps rule match, human confirmation and publication approval as separate facts", async () => {
    const root = await repository(FILES);
    const { ledger } = await run(root);
    const finding = at(ledger, "src/listen.ts", 2);
    const triage = await TriageService.open(root);

    // Findings exist without proposals, and a rule match alone confirms nothing.
    expect((await triage.listFindings()).every((view: FindingView) => view.proposals.length === 0 && view.disposition.classification === "unreviewed")).toBe(true);

    // A person confirming the finding creates no proposal and approves nothing.
    const confirmed = await triage.classifyFinding(finding.id, { classification: "confirmed", note: "The listener is never removed", actor: ACTOR });
    expect(confirmed.disposition).toEqual(expect.objectContaining({ classification: "confirmed", classifiedBy: ACTOR }));
    expect(await triage.listProposals()).toEqual([]);

    const { proposal, created } = await triage.createProposal(finding.id, { actor: ACTOR });
    expect(created).toBe(true);
    expect(proposal).toEqual(expect.objectContaining({ status: "draft", hypothesis: false, humanDisposition: "confirmed", reproduction: "not-attempted" }));
    expect(proposal.approval).toBeUndefined();
    const detail = await triage.getProposal(proposal.id);
    expect(detail.gate.publishable).toBe(false);
    expect(detail.gate.blockers).toEqual(expect.arrayContaining(["No approval is recorded", "Status is draft, not ready-for-publication"]));
    await expect(triage.markProposalReady(proposal.id, ACTOR)).rejects.toThrow(/must be approved/u);

    // The classification is in the shared feedback log, tied to the audit that observed it.
    expect(await listFindingFeedback(root)).toEqual([expect.objectContaining({ origin: "audit", fingerprint: finding.fingerprint, classification: "confirmed", reportDigest: finding.lastSeen.snapshot })]);
  });

  it("says what is not known and fabricates nothing in a generated proposal", async () => {
    const root = await repository(FILES);
    const { proposal, finding } = await proposalFor(root, "src/session.ts", 2);

    expect(proposal.title).toBe("[Unconfirmed] Empty catch block (src/session.ts)");
    expect(proposal.hypothesis).toBe(true);
    expect(proposal.body).toContain("**Unconfirmed hypothesis.**");
    expect(proposal.body).toContain("Not attempted. No reproduction steps are available.");
    expect(proposal.body).toContain("Not assessed. The rule match does not establish that anything fails at run time.");
    expect(proposal.body).toContain("| Problem reproduced | No, not attempted |");
    expect(proposal.body).toContain("`src/session.ts:2`");
    expect(proposal.body).not.toMatch(/steps to reproduce|expected behaviou?r/iu);
    // Locations and rule statements only: no line of the source file is copied in.
    expect(proposal.body).not.toContain("read();");
    expect(proposal.labels).toEqual(["category:reliability", "conclave-audit", "needs-triage", "severity:medium"]);
    expect(proposal.findings).toEqual([{ id: finding.id, fingerprint: finding.fingerprint, evidenceDigest: finding.evidenceDigest }]);
    expect(proposal.revision).toBe(proposalRevision(proposal));
    expect(proposal.coverageLimitations.length).toBeGreaterThan(0);
    expect(proposal.source.snapshot).toBe(finding.lastSeen.snapshot);
  });

  it("is idempotent, and does not re-propose a rejected finding without a reason", async () => {
    const root = await repository(FILES);
    const { triage, finding, proposal } = await proposalFor(root, "src/listen.ts", 2);

    expect(await triage.createProposal(finding.id, { actor: ACTOR })).toEqual({ proposal, created: false });
    await triage.submitProposal(proposal.id, ACTOR);
    expect((await triage.createProposal(finding.fingerprint, { actor: ACTOR })).proposal.status).toBe("pending-review");
    expect(await triage.listProposals()).toHaveLength(1);

    await expect(triage.rejectProposal(proposal.id, { reason: " ", actor: ACTOR })).rejects.toThrow(/requires a reason/u);
    const rejected = await triage.rejectProposal(proposal.id, { reason: "The listener is intentional", actor: ACTOR });
    expect(rejected.proposal).toEqual(expect.objectContaining({ status: "rejected", rejection: expect.objectContaining({ reason: "The listener is intentional" }) as unknown }));

    // Auditing again, any number of times, does not bring it back.
    await run(root);
    await expect(triage.createProposal(finding.id, { actor: ACTOR })).rejects.toThrow(/was rejected \(The listener is intentional\) and its source evidence has not changed/u);
    expect((await triage.listProposals()).map((item) => item.status)).toEqual(["rejected"]);
    expect(await triage.listProposals({ statuses: ["draft", "pending-review"] })).toEqual([]);

    // A stated reason makes a new, linked attempt.
    const again = await triage.createProposal(finding.id, { actor: ACTOR, reason: "Leak confirmed in the profiler" });
    expect(again).toEqual(expect.objectContaining({ created: true }));
    expect(again.proposal).toEqual(expect.objectContaining({ attempt: 2, status: "draft", supersedes: { proposalId: proposal.id, reason: "Leak confirmed in the profiler" } }));
    expect(again.proposal.id).not.toBe(proposal.id);
    expect(await triage.listProposals()).toHaveLength(2);
  });

  it("binds an approval to one revision and requires the review step first", async () => {
    const root = await repository(FILES);
    const { triage, proposal } = await proposalFor(root, "src/listen.ts", 2);
    const request = { revision: proposal.revision, actor: ACTOR, method: "cli-revision" } as const;

    // No path from draft to approved, and nothing approves by itself.
    await expect(triage.approveProposal(proposal.id, request)).rejects.toThrow(/Cannot approve a proposal that is draft/u);
    await triage.submitProposal(proposal.id, ACTOR);
    await run(root);
    expect((await triage.getProposal(proposal.id)).proposal).toEqual(expect.objectContaining({ status: "pending-review" }));
    expect((await triage.getProposal(proposal.id)).proposal.approval).toBeUndefined();

    // An approval that names another revision approves nothing.
    await expect(triage.approveProposal(proposal.id, { ...request, revision: "rev_00000000000000000000000000000000" })).rejects.toThrow(/Approval names revision/u);
    const edited = await triage.editProposal(proposal.id, { title: "Resize listener is never removed" }, ACTOR);
    expect(edited.proposal.revision).not.toBe(proposal.revision);
    await expect(triage.approveProposal(proposal.id, request)).rejects.toThrow(/Approval names revision/u);

    const approved = await triage.approveProposal(proposal.id, { ...request, revision: edited.proposal.revision });
    expect(approved.proposal.status).toBe("approved");
    expect(approved.proposal.approval).toEqual(expect.objectContaining({ revision: edited.proposal.revision, approvedBy: ACTOR, method: "cli-revision" }));
    expect(approved.gate.blockers).toEqual(["Status is approved, not ready-for-publication"]);

    const ready = await triage.markProposalReady(proposal.id, ACTOR);
    expect(ready.proposal.status).toBe("ready-for-publication");
    expect(ready.gate).toEqual({ publishable: true, blockers: [] });
    expect(ready.proposal.history.map((entry) => entry.action)).toEqual(["created", "submitted", "edited", "approved", "marked-ready"]);
  });

  it("voids an approval when the approved text is edited", async () => {
    const root = await repository(FILES);
    const { triage, proposal } = await proposalFor(root, "src/listen.ts", 2);
    await triage.submitProposal(proposal.id, ACTOR);
    await triage.approveProposal(proposal.id, { revision: proposal.revision, actor: ACTOR, method: "cli-revision" });
    await triage.markProposalReady(proposal.id, ACTOR);

    // Not material: line endings, trailing whitespace, label order.
    const cosmetic = await triage.editProposal(proposal.id, { body: proposal.body.replace(/\n/gu, "  \r\n"), labels: [...proposal.labels].reverse() }, ACTOR);
    expect(cosmetic.proposal).toEqual(expect.objectContaining({ status: "ready-for-publication", revision: proposal.revision }));

    const edited = await triage.editProposal(proposal.id, { body: `${proposal.body}\n\nSeen on every route change.` }, ACTOR);
    expect(edited.proposal.status).toBe("pending-review");
    expect(edited.proposal.approval).toBeUndefined();
    expect(edited.proposal.invalidatedApprovals).toEqual([expect.objectContaining({ revision: proposal.revision, reason: expect.stringContaining("Edited") as unknown })]);
    expect(edited.gate.publishable).toBe(false);
    await expect(triage.markProposalReady(proposal.id, ACTOR)).rejects.toThrow(/must be approved/u);

    // The old approval cannot be replayed; the new text needs its own.
    await expect(triage.approveProposal(proposal.id, { revision: proposal.revision, actor: ACTOR, method: "cli-revision" })).rejects.toThrow(/Approval names revision/u);
    expect((await triage.approveProposal(proposal.id, { revision: edited.proposal.revision, actor: ACTOR, method: "cli-revision" })).proposal.status).toBe("approved");
  });

  it("marks a ready proposal stale when the source evidence changes, and requires a new review", async () => {
    const root = await repository(CYCLE);
    const { triage, finding, proposal } = await proposalFor(root, "src/a.ts", 1);
    expect(finding.ruleId).toBe("import-cycle");
    await triage.submitProposal(proposal.id, ACTOR);
    await triage.approveProposal(proposal.id, { revision: proposal.revision, actor: ACTOR, method: "cli-revision" });
    await triage.markProposalReady(proposal.id, ACTOR);

    // An unrelated edit, and a pure move of the evidence, change nothing.
    await put(root, { "src/c.ts": "export const c = 3;\n", "src/b.ts": `// moved down\n${CYCLE["src/b.ts"]}` });
    const moved = await run(root);
    expect(moved.ledger.findings[finding.fingerprint]?.evidenceDigest).toBe(finding.evidenceDigest);
    expect((await triage.getProposal(proposal.id)).gate.publishable).toBe(true);

    // The cycle is still there, through a different import statement.
    await put(root, { "src/b.ts": "import { a, a as alias } from \"./a.js\";\nexport const b = () => [a, alias];\n" });
    const changed = await run(root);
    expect(changed.ledger.findings[finding.fingerprint]?.state).toBe("persistent");
    expect(changed.ledger.findings[finding.fingerprint]?.evidenceDigest).not.toBe(finding.evidenceDigest);

    const stale = await triage.getProposal(proposal.id);
    expect(stale.proposal.status).toBe("stale");
    expect(stale.proposal.stale).toEqual(expect.objectContaining({ previousStatus: "ready-for-publication", reason: expect.stringContaining("source text behind finding") as unknown }));
    expect(stale.proposal.approval).toBeUndefined();
    expect(stale.proposal.invalidatedApprovals).toHaveLength(1);
    expect(stale.gate.publishable).toBe(false);
    await expect(triage.approveProposal(proposal.id, { revision: proposal.revision, actor: ACTOR, method: "cli-revision" })).rejects.toThrow(/Cannot approve a proposal that is stale/u);
    await expect(triage.markProposalReady(proposal.id, ACTOR)).rejects.toThrow(/must be approved/u);

    // Renewed review: refresh returns it to draft, bound to the current evidence, with no approval.
    const refreshed = await triage.refreshProposal(proposal.id, ACTOR);
    expect(refreshed.proposal).toEqual(expect.objectContaining({ status: "draft", id: proposal.id }));
    expect(refreshed.proposal.findings[0]?.evidenceDigest).toBe(changed.ledger.findings[finding.fingerprint]?.evidenceDigest);
    expect(refreshed.proposal.approval).toBeUndefined();

    // A finding that goes away takes its proposal with it.
    await put(root, { "src/b.ts": "export const b = 2;\n" });
    await run(root);
    expect((await triage.getProposal(proposal.id)).proposal).toEqual(expect.objectContaining({ status: "stale", stale: expect.objectContaining({ reason: expect.stringContaining("was resolved") as unknown }) as unknown }));
    await expect(triage.refreshProposal(proposal.id, ACTOR)).rejects.toThrow(/resolved/u);
  });

  it("voids an approval when the finding is reclassified", async () => {
    const root = await repository(FILES);
    const { triage, finding, proposal } = await proposalFor(root, "src/listen.ts", 2);
    await triage.submitProposal(proposal.id, ACTOR);
    await triage.approveProposal(proposal.id, { revision: proposal.revision, actor: ACTOR, method: "cli-revision" });

    const view = await triage.classifyFinding(finding.id, { classification: "false-positive", note: "Removed by the framework on unmount", actor: ACTOR });
    expect(view.proposals).toEqual([{ id: proposal.id, status: "stale", attempt: 1 }]);
    expect(view.issueEligibility.eligible).toBe(false);
    expect((await triage.getProposal(proposal.id)).proposal.approval).toBeUndefined();
    await expect(triage.refreshProposal(proposal.id, ACTOR)).rejects.toThrow(/false positive/u);
  });

  it("does not let the stored status stand in for an approval", async () => {
    const root = await repository(FILES);
    const { triage, proposal } = await proposalFor(root, "src/listen.ts", 2);
    const ledger = (await loadFindingLedger(root)).value as FindingLedger;
    const path = join(root, ".conclave", "issues", "proposals.json");
    const store = JSON.parse(await readFile(path, "utf8")) as IssueProposalStore;

    // Someone edits the state file to say the draft is ready.
    const flagged: IssueProposal = { ...proposal, status: "ready-for-publication" };
    expect(publicationGate(flagged, ledger.findings)).toEqual({ publishable: false, blockers: ["No approval is recorded"] });

    // Or copies a real approval onto text it never covered.
    await triage.submitProposal(proposal.id, ACTOR);
    const approved = (await triage.approveProposal(proposal.id, { revision: proposal.revision, actor: ACTOR, method: "cli-revision" })).proposal;
    const swapped: IssueProposal = { ...approved, status: "ready-for-publication", body: `${approved.body}\n\nUnreviewed addition.` };
    expect(publicationGate(swapped, ledger.findings).blockers).toEqual(expect.arrayContaining(["Stored revision does not match the proposal text", expect.stringContaining("Approval covers revision")]));

    await writeFile(path, JSON.stringify({ ...store, proposals: { [proposal.id]: swapped } }));
    expect((await triage.getProposal(proposal.id)).gate.publishable).toBe(false);
  });

  it("keeps credential-shaped source text out of findings, proposals and stored state", async () => {
    const root = await repository({
      "src/store.ts": [
        "const KEY = \"session\";",
        "export function save(value: string) { localStorage.setItem(KEY, value); }",
        `export function load() { return localStorage.getItem("${SLACK_SHAPED}"); }`,
        "",
      ].join("\n"),
    });
    const { report, ledger } = await run(root);
    const finding = Object.values(ledger.findings).find((item) => item.ruleId === "inconsistent-key");
    expect(finding?.explanation).toContain("[REDACTED:credential]");
    const triage = await TriageService.open(root);
    const { proposal } = await triage.createProposal(finding?.id ?? "", { actor: ACTOR });
    expect(proposal.body).toContain("[REDACTED:credential]");

    const stored = await Promise.all([".conclave/audits/latest.json", ".conclave/findings/ledger.json", ".conclave/issues/proposals.json"].map((path) => readFile(join(root, path), "utf8")));
    const source = await triage.readFindingEvidence(finding?.id ?? "");
    for (const output of [JSON.stringify(report), JSON.stringify(proposal), JSON.stringify(source), ...stored]) expect(output).not.toContain(SLACK_SHAPED);
    expect(JSON.stringify(source)).toContain("[REDACTED:credential]");

    // A person cannot put one in either: the edit and the note are refused, not silently rewritten.
    await expect(triage.editProposal(proposal.id, { body: `${proposal.body}\n\nToken: ${SLACK_SHAPED}` }, ACTOR)).rejects.toThrow(/matched a credential detector/u);
    await expect(triage.editProposal(proposal.id, { title: `Key ${SLACK_SHAPED}` }, ACTOR)).rejects.toThrow(/matched a credential detector/u);
    await expect(triage.classifyFinding(finding?.id ?? "", { classification: "confirmed", note: `see ${SLACK_SHAPED}`, actor: ACTOR })).rejects.toThrow(/matched a credential detector/u);
    await expect(triage.rejectProposal(proposal.id, { reason: `leaks ${SLACK_SHAPED}`, actor: ACTOR })).rejects.toThrow(/matched a credential detector/u);
    for (const path of [".conclave/issues/proposals.json", ".conclave/findings/ledger.json"]) expect(await readFile(join(root, path), "utf8")).not.toContain(SLACK_SHAPED);
    expect(await listFindingFeedback(root)).toEqual([]);
  });

  it("reads evidence only from inside the repository and withholds credential files", async () => {
    const root = await repository(FILES);
    const outside = await repository({ "secret.ts": "export const outside = 1;\n" });
    const { ledger } = await run(root);
    const finding = at(ledger, "src/listen.ts", 2);
    const triage = await TriageService.open(root);
    expect((await triage.readFindingEvidence(finding.id))[0]?.lines?.map((line) => line.number)).toEqual([1, 2, 3, 4]);

    // A tampered ledger cannot point the reader at another directory or at a credential file.
    const tampered = (path: string): FindingLedger => ({ ...ledger, findings: { ...ledger.findings, [finding.fingerprint]: { ...finding, evidence: [{ path, startLine: 1, endLine: 1, reason: "x" }] } } });
    await saveFindingLedger(root, tampered(`../${outside.split("/").pop() ?? ""}/secret.ts`));
    expect((await triage.readFindingEvidence(finding.id))[0]).toEqual(expect.objectContaining({ withheld: "Path leaves the repository" }));
    await put(root, { ".env": "TOKEN=value\n" });
    await saveFindingLedger(root, tampered(".env"));
    expect((await triage.readFindingEvidence(finding.id))[0]).toEqual(expect.objectContaining({ withheld: "File name matches a credential pattern" }));
    expect(JSON.stringify(await triage.readFindingEvidence(finding.id))).not.toContain("TOKEN=value");
  });

  it("neutralizes repository-controlled text in the generated issue body", async () => {
    // A file name is repository content; here it tries to mention a user and close the code span.
    const hostile = "src/@maintainer `x` [link](javascript:alert).ts";
    const root = await repository({ [hostile]: "export function quiet() {\n  try { go(); } catch {}\n}\n" });
    const { proposal } = await proposalFor(root, hostile, 2);
    const outsideCode = proposal.body.replace(/```text\n[\s\S]*?\n```/gu, "").replace(/`[^`\n]*`/gu, "");

    expect(outsideCode).not.toContain("@maintainer");
    expect(outsideCode).not.toContain("[link](");
    expect(proposal.body).toContain("`src/@maintainer 'x' [link](javascript:alert).ts:2`");
  });
});

describe("triage commands", () => {
  async function output(command: (args: readonly string[]) => Promise<void>, args: readonly string[]): Promise<string> {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await command(args);
      return log.mock.calls.map((call) => call.join(" ")).join("\n");
    } finally {
      log.mockRestore();
    }
  }

  it("walks the whole local workflow from the command line", async () => {
    const root = await repository(FILES);
    await run(root);
    const repo = ["--repo", root];

    const listed = JSON.parse(await output(findingsCommand, ["list", ...repo, "--rule", "unreleased-resource", "--json"])) as readonly FindingView[];
    expect(listed).toHaveLength(1);
    const id = listed[0]?.id.slice(-20, -10) ?? "";
    expect(await output(findingsCommand, ["list", ...repo])).toContain("4 of 4 recorded finding(s): 4 new.");
    expect(await output(findingsCommand, ["runs", ...repo])).toContain("NOT EVALUATED");

    const shown = await output(findingsCommand, ["show", id, ...repo, "--source"]);
    expect(shown).toContain("reproduced              no, not attempted");
    expect(shown).toContain("human disposition       unreviewed");
    expect(shown).toContain("    2 │   window.addEventListener(\"resize\", onResize);");

    expect(await output(findingsCommand, ["classify", id, "--as", "confirmed", "--note", "Never removed", ...repo])).toContain("approves no issue proposal");
    await expect(findingsCommand(["classify", id, "--as", "false-positive", ...repo])).rejects.toThrow(/requires a note/u);
    await expect(findingsCommand(["classify", id, "--as", "fixed", ...repo])).rejects.toThrow(/--as must be one of/u);

    const drafted = JSON.parse(await output(issuesCommand, ["propose", id, ...repo, "--json"])) as { readonly proposal: IssueProposal; readonly created: boolean };
    expect(drafted).toEqual(expect.objectContaining({ created: true }));
    const proposal = drafted.proposal.id.slice(-20, -10);
    expect(await output(issuesCommand, ["show", proposal, ...repo])).toContain("## What was observed");

    const body = join(root, "..", `${String(Date.now())}-body.md`);
    roots.push(body);
    await writeFile(body, `${drafted.proposal.body}\n\nAffects every page.\n`);
    const edited = JSON.parse(await output(issuesCommand, ["edit", proposal, "--title", "Resize listener is never removed", "--body-file", body, "--label", "bug", "--label", "conclave-audit", ...repo, "--json"])) as { readonly proposal: IssueProposal };
    expect(edited.proposal).toEqual(expect.objectContaining({ title: "Resize listener is never removed", labels: ["bug", "conclave-audit"], status: "draft" }));

    expect(await output(issuesCommand, ["submit", proposal, ...repo])).toContain("Submitted for review. It is not approved.");
    // Not a terminal, no revision: approval is refused instead of assumed.
    await expect(issuesCommand(["approve", proposal, ...repo])).rejects.toThrow(/Approval is an explicit action/u);
    await expect(issuesCommand(["approve", proposal, "--revision", "rev_1234", ...repo])).rejects.toThrow(/at least 12 characters/u);
    await expect(issuesCommand(["approve", proposal, "--revision", drafted.proposal.revision, ...repo])).rejects.toThrow(/Approval names revision/u);
    expect(await output(issuesCommand, ["approve", proposal, "--revision", edited.proposal.revision.slice(0, 16), ...repo])).toContain(`Approved revision ${edited.proposal.revision}`);
    expect(await output(issuesCommand, ["ready", proposal, ...repo])).toContain("nothing was published");
    expect(await output(issuesCommand, ["list", ...repo])).toMatch(/ready-for-publication\s+rev_[a-f0-9]{8}\s+this revision/u);

    await expect(issuesCommand(["publish", proposal, ...repo])).rejects.toThrow(/Publishing is not implemented/u);
    await expect(issuesCommand(["approve", proposal, "--force", ...repo])).rejects.toThrow(/Unknown option: --force/u);
    await expect(findingsCommand(["show", "zzzzzz", ...repo])).rejects.toThrow(/No finding matches/u);
    await expect(findingsCommand(["show", "../../etc", ...repo])).rejects.toThrow(/reference is its id/u);
  });

  it("calls no network, GitHub tool or model through the entire workflow", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
    const bin = await mkdtemp(join(tmpdir(), "conclave-workflow-bin-"));
    roots.push(bin);
    const marker = join(bin, "INVOKED");
    for (const tool of ["gh", "hub", "curl", "wget", "npm", "npx"]) {
      await writeFile(join(bin, tool), `#!/bin/sh\necho ${tool} >> "${marker}"\n`);
      await chmod(join(bin, tool), 0o755);
    }
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env["PATH"] ?? ""}`);
    vi.stubEnv("CONCLAVE_MODE", "api");
    vi.stubEnv("CONCLAVE_PROVIDER", "openai");
    vi.stubEnv("CONCLAVE_API_KEY", "synthetic");
    vi.stubEnv("GITHUB_TOKEN", "synthetic");

    const root = await repository(FILES);
    const { triage, finding, proposal } = await proposalFor(root, "src/listen.ts", 2);
    await triage.classifyFinding(finding.id, { classification: "confirmed", actor: ACTOR });
    const current = (await triage.getProposal(proposal.id)).proposal;
    await triage.submitProposal(proposal.id, ACTOR);
    await triage.approveProposal(proposal.id, { revision: current.revision, actor: ACTOR, method: "cli-revision" });
    const ready = await triage.markProposalReady(proposal.id, ACTOR);
    await run(root);

    expect(ready.proposal.status).toBe("ready-for-publication");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
    expect(JSON.stringify(await loadIssueProposals(root))).not.toContain("synthetic");

    // The workflow's own modules have no way to reach a network or start a process.
    for (const file of ["src/workflow/triage-service.ts", "src/validation/issue-proposal.ts", "src/validation/finding-lifecycle.ts", "src/storage/finding-ledger.ts", "src/storage/state-file.ts", "src/analysis/audit-policy.ts", "src/cli-triage.ts"]) {
      expect(await readFile(resolve(file), "utf8"), file).not.toMatch(/node:(?:https?|net|tls|dgram|child_process|worker_threads)|\bfetch\(|api\.github\.com/u);
    }
  });
});

describe("change review", () => {
  it("is unaffected by a ledger, a baseline and proposals in the same repository", async () => {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const git = async (root: string, ...args: string[]): Promise<void> => {
      await promisify(execFile)("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root });
    };
    const root = await repository(FILES);
    await git(root, "init", "-q", "-b", "main");
    await git(root, "add", "-A");
    await git(root, "commit", "-q", "-m", "feat: session helpers");
    await put(root, { "src/session.ts": `${SESSION}export function clear() {\n  try { wipe(); } catch {}\n}\n` });

    const before = await check({ repository: root, objective: "Add clear()" });
    await auditRepositoryWithLedger(root, { write: true, updateBaseline: true });
    const { triage, proposal } = await proposalFor(root, "src/listen.ts", 2);
    await triage.submitProposal(proposal.id, ACTOR);
    const state = await Promise.all(["findings/ledger.json", "issues/proposals.json"].map((path) => readFile(join(root, ".conclave", path), "utf8")));
    await unlink(join(root, BASELINE_FILENAME));
    const after = await check({ repository: root, objective: "Add clear()" });

    // Same verdict and the same findings, by identity: audit state does not leak into review.
    expect(after.verdict).toBe(before.verdict);
    expect(after.report.schemaVersion).toBe(before.report.schemaVersion);
    expect(after.report.findings.map((finding) => [finding.kind, finding.severity, finding.fingerprint])).toEqual(before.report.findings.map((finding) => [finding.kind, finding.severity, finding.fingerprint]));
    for (const finding of after.report.findings) expect(Object.keys(finding)).not.toEqual(expect.arrayContaining(["baseline", "applicability", "evidenceDigest"]));
    // And review does not touch audit state.
    expect(await Promise.all(["findings/ledger.json", "issues/proposals.json"].map((path) => readFile(join(root, ".conclave", path), "utf8")))).toEqual(state);
  });
});
