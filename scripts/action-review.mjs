import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const action = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { createReviewDecision } = await import(pathToFileURL(resolve(action, "dist/domain/review-decision.js")));
const repository = resolve(process.env.CONCLAVE_REPOSITORY || ".");
const reportPath = resolve(process.env.RUNNER_TEMP || repository, "conclave-report.json");
const commit = (ref) => {
  if (!ref) throw new Error("A Git comparison ref is required");
  const sha = execFileSync("git", ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], { cwd: repository, encoding: "utf8" }).trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error("Git ref did not resolve to a commit");
  return sha;
};
const args = [resolve(action, "dist/cli.js"), "review", repository, "--base", commit(process.env.CONCLAVE_BASE), "--head", commit(process.env.CONCLAVE_HEAD || "HEAD"), "--objective", process.env.CONCLAVE_OBJECTIVE, "--json"];
for (const [key, flag] of [["CONCLAVE_CONTRACT", "--contract"], ["CONCLAVE_RECEIPTS", "--receipt"], ["CONCLAVE_PREVIOUS", "--previous-report"]]) if (process.env[key]) args.push(flag, resolve(repository, process.env[key]));
let code = 0; let stdout;
try { stdout = execFileSync(process.execPath, args, { cwd: repository, encoding: "utf8", maxBuffer: 8_000_000, timeout: 120_000 }); }
catch (error) { code = error.status ?? 3; stdout = error.stdout; }
if (!stdout?.trim()) throw new Error(`Conclave did not produce a report (exit ${code})`);
const report = JSON.parse(stdout);
if (!["pass", "warn", "block", "inconclusive"].includes(report.verdict) || code !== (report.verdict === "block" ? 1 : report.verdict === "inconclusive" ? 2 : 0)) throw new Error("Conclave verdict and process exit disagree");
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
const decision = createReviewDecision(report);
const safe = (text) => String(text).replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("@", "＠");
const body = ["<!-- conclave-ai-review -->", "## Conclave delivery review", `**${report.verdict.toUpperCase()}** — ${safe(decision.headline)}`, safe(decision.nextAction), "", ...decision.attention.map((item) => `- ${safe(item.title)}: ${safe(item.remediation)}`), "", "### Verification still needed", ...decision.verificationGaps.map((item) => `- ${safe(item)}`), "", safe(decision.progress), "", "PASS describes structural findings. A human decides whether to merge."].join("\n").slice(0, 60000);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, body + "\n");
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `report=${reportPath}\nverdict=${report.verdict}\n`);
const token = process.env.CONCLAVE_COMMENT_TOKEN;
if (token && process.env.GITHUB_EVENT_NAME === "pull_request") {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const slug = process.env.GITHUB_REPOSITORY;
  if (event.pull_request?.head.repo.full_name === slug) {
    const base = `https://api.github.com/repos/${slug}`;
    const api = async (path, method = "GET", data) => {
      const result = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json" }, ...(data === undefined ? {} : { body: JSON.stringify(data) }), signal: AbortSignal.timeout(15000) });
      if (!result.ok) throw new Error(`GitHub comment request failed: ${result.status}`);
      return result.json();
    };
    let previous;
    for (let page = 1; page <= 100; page++) {
      const comments = await api(`/issues/${event.number}/comments?per_page=100&page=${page}`);
      previous = comments.find((item) => item.user?.login === "github-actions[bot]" && item.body?.startsWith("<!-- conclave-ai-review -->"));
      if (previous || comments.length < 100) break;
      if (page === 100) throw new Error("Comment pagination limit reached; refusing to create a duplicate");
    }
    if (previous) await api(`/issues/comments/${previous.id}`, "PATCH", { body });
    else await api(`/issues/${event.number}/comments`, "POST", { body });
  }
}
process.exitCode = code;
