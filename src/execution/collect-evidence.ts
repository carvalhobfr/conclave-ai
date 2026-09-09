import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { EvidenceReceiptInput, EvidenceReceiptType, ValidationReport } from "../domain/validation.js";
import { GitChangeSetService } from "../validation/git-change-set.js";
import { validationDigest } from "../validation/review-lineage.js";

interface ExecutionCheck { readonly id: string; readonly type: EvidenceReceiptType; readonly argv: readonly string[]; readonly timeoutMs: number; readonly criterionIds: readonly string[] }

export function parseExecutionPlan(value: unknown): readonly ExecutionCheck[] {
  const plan = value as { version?: unknown; checks?: unknown } | null;
  if (plan?.version !== 1 || !Array.isArray(plan.checks) || plan.checks.length === 0 || plan.checks.length > 20) throw new Error("Execution plan requires version 1 and 1–20 checks");
  const checks = plan.checks.map((entry: unknown): ExecutionCheck => {
    const item = entry as Partial<ExecutionCheck> | null;
    if (item === null || typeof item.id !== "string" || !/^[\w-]{1,100}$/u.test(item.id) || !["test", "build", "lint", "typecheck", "runtime", "benchmark", "other"].includes(item.type ?? "") || !Array.isArray(item.argv) || item.argv.length === 0 || item.argv.length > 100 || item.argv.some((v) => typeof v !== "string" || v.length > 4000 || v.includes("\0")) || !String(item.argv[0] ?? "").trim() || !Number.isInteger(item.timeoutMs) || (item.timeoutMs ?? 0) < 100 || (item.timeoutMs ?? 0) > 300_000 || !Array.isArray(item.criterionIds) || item.criterionIds.length > 100 || item.criterionIds.some((id) => typeof id !== "string")) throw new Error("Invalid execution check: supply id, type, argv, timeoutMs (100–300000) and criterionIds");
    return item as ExecutionCheck;
  });
  if (new Set(checks.map((item) => item.id)).size !== checks.length) throw new Error("Execution check IDs must be unique");
  if (checks.reduce((sum, item) => sum + item.timeoutMs, 0) > 900_000) throw new Error("Total execution timeout exceeds 15 minutes");
  return checks;
}

export async function executeCheck(check: ExecutionCheck, root: string): Promise<{ exitCode: number; outputDigest: string; summary: string }> {
  return new Promise((done) => {
    const hash = createHash("sha256");
    let bytes = 0; let failure = "";
    const child = spawn(check.argv[0] ?? "", [...check.argv.slice(1)], { cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
    const stop = () => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => { child.kill(); });
      } else { try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } }
    };
    const timer = setTimeout(() => { failure = "Execution timed out"; stop(); }, check.timeoutMs);
    const capture = (data: Buffer) => {
      bytes += data.length;
      if (bytes > 1_000_000) { failure = "Execution exceeded the 1 MB output limit"; stop(); }
      else hash.update(data);
    };
    child.stdout.on("data", capture); child.stderr.on("data", capture);
    child.on("error", () => { failure = "Execution could not be started"; });
    child.on("close", (code) => { clearTimeout(timer); done({ exitCode: failure ? 1 : code ?? 1, outputDigest: hash.digest("hex"), summary: failure || "Execution completed; output is hashed, not stored. Test adequacy requires review." }); });
  });
}

export async function collectExecutionEvidence(root: string, report: ValidationReport, planValue: unknown): Promise<readonly EvidenceReceiptInput[]> {
  const checks = parseExecutionPlan(planValue);
  const criteria = new Map((report.criteria ?? []).map((item) => [item.criterion.id, item]));
  for (const check of checks) for (const id of check.criterionIds) if (!criteria.has(id)) throw new Error("Unknown criterion: " + id);
  const changes = new GitChangeSetService();
  const assertArtifact = async () => {
    const current = await changes.collect(root, report.changeSet.source);
    if (current.headSha !== report.changeSet.headSha || validationDigest("diff", current.patch) !== report.lineage.diffDigest) throw new Error("Reviewed artifact changed; collect a fresh review before running checks");
    if (report.changeSet.source.kind === "branch" || report.changeSet.source.kind === "commit") {
      const working = await changes.collect(root, { kind: "working" });
      const staged = await changes.collect(root, { kind: "staged" });
      if (working.headSha !== report.changeSet.headSha || working.files.length || staged.files.length) throw new Error("Execution of an immutable review requires its clean checkout");
    }
  };
  await assertArtifact();
  const receipts: EvidenceReceiptInput[] = [];
  for (const check of checks) {
    const startedAt = new Date().toISOString();
    const result = await executeCheck(check, resolve(root));
    const finishedAt = new Date().toISOString();
    await assertArtifact();
    receipts.push({ id: check.id, type: check.type, command: JSON.stringify(check.argv), startedAt, finishedAt, headSha: report.changeSet.headSha, diffDigest: report.lineage.diffDigest, runner: "conclave-opt-in-runner", claimedTrustLevel: "locally-observed", criterionDigests: Object.fromEntries(check.criterionIds.map((id) => [id, criteria.get(id)?.digest ?? ""])), ...result });
  }
  return receipts;
}

export async function collectCommand(args: readonly string[]): Promise<void> {
  if (args.length !== 4) throw new Error("Usage: conclave collect REPOSITORY REPORT.json PLAN.json OUTPUT.json (executes the explicit plan)");
  const [root, reportPath, planPath, output] = args as readonly [string, string, string, string];
  const reportValue = JSON.parse(await readFile(reportPath, "utf8")) as ValidationReport | { report: ValidationReport };
  const report = "report" in reportValue ? reportValue.report : reportValue;
  const receipts = await collectExecutionEvidence(root, report, JSON.parse(await readFile(planPath, "utf8")));
  await writeFile(output, JSON.stringify({ version: 1, receipts }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  if (receipts.some((item) => item.exitCode !== 0)) process.exitCode = 1;
}
