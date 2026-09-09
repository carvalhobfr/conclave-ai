import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import type { EvidenceReceiptInput, ValidationReport } from "../domain/validation.js";
import { assertReviewedArtifact } from "./collect-evidence.js";

interface SmokeStep { readonly action: "open" | "fill" | "click" | "reload" | "assert-text" | "assert-value"; readonly selector?: string; readonly value?: string }
export interface SmokePlan { readonly version: 1; readonly id: string; readonly baseURL: string; readonly criterionIds: readonly string[]; readonly steps: readonly SmokeStep[] }

export function parseSmokePlan(value: unknown): SmokePlan {
  if (typeof value !== "object" || value === null) throw new Error("Browser plan must be an object");
  const p = value as Partial<SmokePlan>;
  if (p.version !== 1 || typeof p.id !== "string" || !/^[\w-]{1,100}$/u.test(p.id) || typeof p.baseURL !== "string" || !Array.isArray(p.steps) || p.steps.length === 0 || p.steps.length > 20 || !Array.isArray(p.criterionIds) || p.criterionIds.length > 100 || p.criterionIds.some((id) => typeof id !== "string")) throw new Error("Browser plan requires version, id, baseURL, criterionIds and 1–20 steps");
  const url = new URL(p.baseURL);
  if (!["http:", "https:"].includes(url.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password) throw new Error("Browser smoke tests require a loopback HTTP URL without credentials");
  for (const raw of p.steps as readonly unknown[]) {
    if (typeof raw !== "object" || raw === null) throw new Error("Unsupported browser step");
    const item = raw as Partial<SmokeStep>;
    if (!["open", "fill", "click", "reload", "assert-text", "assert-value"].includes(item.action ?? "")) throw new Error("Unsupported browser step");
    if (item.action !== "open" && item.action !== "reload" && (typeof item.selector !== "string" || !item.selector.trim() || item.selector.length > 1000)) throw new Error("Browser interaction requires a bounded selector");
    if (["open", "fill", "assert-text", "assert-value"].includes(item.action ?? "") && (typeof item.value !== "string" || item.value.length > 4000)) throw new Error("Browser step requires a bounded value");
    if (item.action === "open" && new URL(item.value ?? "", url).origin !== url.origin) throw new Error("Browser navigation must remain on the configured origin");
  }
  if (!(p.steps as readonly SmokeStep[]).some((item) => item.action.startsWith("assert-"))) throw new Error("A smoke plan needs at least one behavioral assertion");
  return p as SmokePlan;
}

/** Explicit opt-in; opens a fresh browser context without an existing user profile. */
export async function runSmokePlan(plan: SmokePlan): Promise<{ exitCode: number; summary: string; outputDigest: string }> {
  const { chromium } = await import("playwright").catch(() => { throw new Error("Browser collection requires optional playwright. Install playwright and run playwright install chromium."); });
  const browser = await chromium.launch({ headless: true });
  const trace: string[] = [];
  const deadline = Date.now() + 90_000;
  const timer = setTimeout(() => { void browser.close().catch(() => undefined); }, 90_000);
  try {
    const origin = new URL(plan.baseURL).origin;
    const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
    context.setDefaultTimeout(5000);
    await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket(/.*/u, (route) => {
      const url = new URL(route.url()); url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      if (url.origin === origin) route.connectToServer(); else void route.close();
    });
    const page = await context.newPage();
    await page.goto(plan.baseURL);
    for (const [index, step] of plan.steps.entries()) {
      trace.push(`step ${String(index + 1)}: ${step.action}`);
      if (step.action === "open") await page.goto(new URL(step.value ?? "", plan.baseURL).href);
      else if (step.action === "reload") await page.reload();
      else {
        const locator = page.locator(step.selector ?? "");
        if (step.action === "fill") await locator.fill(step.value ?? "");
        else if (step.action === "click") await locator.click();
        else {
          const deadline = Date.now() + 5000;
          let matches = false;
          do {
            const actual = step.action === "assert-value" ? await locator.inputValue() : await locator.textContent();
            matches = step.action === "assert-value" ? actual === step.value : (actual ?? "").includes(step.value ?? "");
            if (!matches) await new Promise((done) => setTimeout(done, 50));
          } while (!matches && Date.now() < deadline);
          if (!matches) throw new Error("Behavioral assertion failed");
        }
      }
      trace.push("passed");
    }
    return { exitCode: 0, summary: `All ${String(plan.steps.length)} browser steps passed in a fresh context. Coverage is limited to this scenario.`, outputDigest: createHash("sha256").update(trace.join("\n")).digest("hex") };
  } catch {
    const summary = Date.now() >= deadline ? "Browser plan exceeded 90 seconds" : `Browser scenario failed at ${trace.at(-1) ?? "initial navigation"}`;
    return { exitCode: 1, summary, outputDigest: createHash("sha256").update(trace.join("\n") + "\nfailed").digest("hex") };
  } finally { clearTimeout(timer); await browser.close(); }
}

export async function smokeCommand(args: readonly string[]): Promise<void> {
  if (args.length !== 4) throw new Error("Usage: conclave smoke REPOSITORY REPORT.json PLAN.json OUTPUT.json (interacts with the declared local app)");
  const [root, reportPath, planPath, output] = args as readonly [string, string, string, string];
  const raw = JSON.parse(await readFile(reportPath, "utf8")) as ValidationReport | { report: ValidationReport };
  const report = "report" in raw ? raw.report : raw;
  const plan = parseSmokePlan(JSON.parse(await readFile(planPath, "utf8")));
  const criterionDigests: Record<string, string> = {};
  for (const id of plan.criterionIds) {
    const item = report.criteria?.find((entry) => entry.criterion.id === id);
    if (item === undefined) throw new Error("Unknown smoke criterion: " + id);
    Object.defineProperty(criterionDigests, id, { value: item.digest, enumerable: true });
  }
  await assertReviewedArtifact(root, report);
  const startedAt = new Date().toISOString();
  const result = await runSmokePlan(plan);
  const finishedAt = new Date().toISOString();
  await assertReviewedArtifact(root, report);
  const receipt: EvidenceReceiptInput = { id: plan.id, type: "runtime", command: "conclave smoke " + plan.id, startedAt, finishedAt, runner: "conclave-browser-smoke", claimedTrustLevel: "locally-observed", headSha: report.changeSet.headSha, diffDigest: report.lineage.diffDigest, criterionDigests, ...result };
  await writeFile(output, JSON.stringify({ version: 1, receipts: [receipt] }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log(result.summary);
  process.exitCode = result.exitCode;
}
