const objectiveIndex = process.argv.indexOf("--objective");
const objective = objectiveIndex < 0 ? "" : process.argv[objectiveIndex + 1] ?? "";
const verdict = objective.includes("BLOCK") ? "block" : objective.includes("INCONCLUSIVE") ? "inconclusive" : "pass";
const exit = { pass: 0, block: 1, inconclusive: 2 }[verdict];
const outcome = verdict === "block" ? "rejected" : verdict === "inconclusive" ? "inconclusive" : "supported";
const severity = verdict === "block" ? "blocking" : "warning";
const findings = verdict === "pass" ? [] : [{ id: "finding", fingerprint: "fingerprint", kind: verdict === "block" ? "claim-contradicted" : "claim-inconclusive", severity, title: verdict, detail: verdict, evidence: [], remediation: "Fix or add evidence." }];
process.stdout.write(JSON.stringify({
  schemaVersion: Number(process.env.CONCLAVE_FIXTURE_SCHEMA ?? 2),
  verdict,
  summary: verdict.toUpperCase(),
  objective,
  changeSet: { source: { kind: "working" }, headSha: "abc", files: [], collectedAt: new Date(0).toISOString(), patchBytes: 0 },
  findings,
  claims: [{ claim: { id: "claim", statement: "Claim", check: { kind: "symbol-exists", symbol: "value", expectation: "present" } }, outcome, explanation: outcome, evidence: [] }],
  impact: { changedSymbols: [], impactedFiles: [], impactedSymbols: [] },
  metrics: { filesChanged: 0, symbolsChanged: 0, impactedFiles: 0, impactedSymbols: 0, graphEdgesInspected: 0, deterministicChecks: 1, durationMs: 1 },
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
    seriesId: "series",
    reviewId: "review",
    baselineTrust: "none",
    objectiveDigest: "objective",
    contractDigest: "contract",
    diffDigest: "diff",
    artifactDigest: "artifact",
    reportDigest: "report",
    contractStatus: "initial",
    rebaselineRequired: false,
    contractDelta: {
      objectiveChanged: false,
      addedClaimIds: [],
      removedClaimIds: [],
      changedClaimIds: [],
      allowedPathPrefixesAdded: [],
      allowedPathPrefixesRemoved: [],
    },
    contractSnapshot: { allowedPathPrefixes: [], claims: [] },
  },
  findingLifecycle: {
    progress: "initial",
    current: findings.map((finding) => ({ fingerprint: finding.fingerprint, status: "new", occurrences: 1, consecutive: 1 })),
    resolved: [],
    seen: findings.map((finding) => finding.fingerprint),
    stagnating: [],
  },
  receipts: { items: [], counts: { current: 0, stale: 0, invalid: 0, failed: 0, unbound: 0 } },
  escalation: { recommended: false, dimensions: [], reasons: [] },
  challengePlan: [{ strategy: "baseline", reason: "Baseline", evidenceIds: [], suggestedProbes: [] }],
}));
process.exitCode = exit;
