import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";

import { ConclaveProductService } from "../src/web/product-service.js";
import { createConclaveWebServer } from "../src/web/server.js";

// The repository-intelligence journey in a real browser, with a static audit so that no model is
// called: audit, findings, evidence, classification, proposal, edit, submit, approval, rejection.
it.skipIf(process.env["CONCLAVE_BROWSER_TESTS"] !== "1")("audits a repository and takes a finding to an approved proposal", async () => {
  const parent = await mkdtemp(join(tmpdir(), "conclave-intelligence-browser-"));
  const root = join(parent, "shop");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "session.js"), "export function save(storage, value) {\n  try { storage.setItem('s', value); } catch {}\n  return true;\n}\n\nexport function watch(target, onResize) {\n  target.addEventListener('resize', onResize);\n}\n");
  const server = createConclaveWebServer({ product: new ConclaveProductService({ allowedRoot: parent, environment: {}, environmentPath: join(parent, "settings.env") }) });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No server port");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    const modelRequests: string[] = []; page.on("request", (request) => { if (!request.url().startsWith(`http://127.0.0.1:${String(address.port)}/`)) modelRequests.push(request.url()); });
    await page.goto(`http://127.0.0.1:${String(address.port)}/?repository=${encodeURIComponent(root)}`);

    // Overview before any audit, then a static audit from the controls.
    await page.getByRole("heading", { name: "Nothing audited yet" }).waitFor();
    await page.getByRole("button", { name: "Run the first audit" }).click();
    await page.getByRole("button", { name: "Start Static audit" }).click();
    await page.getByRole("region", { name: "Audit run status" }).getByText("completed").waitFor();
    expect(await page.getByRole("region", { name: "AI coverage" }).innerText()).toContain("No region was read by a model");

    // A semantic mode without a provider says so and cannot be started.
    await page.getByRole("radio", { name: /^Smart/u }).click();
    await page.getByText(/cannot run as configured/u).waitFor();
    expect(await page.getByRole("button", { name: "Start Smart audit" }).isDisabled()).toBe(true);

    const navigation = page.getByRole("navigation", { name: "Workspace navigation" });
    await navigation.getByRole("button", { name: /Findings inbox/u }).click();
    const table = page.getByRole("table", { name: "Findings" });
    await table.getByText("Static finding").first().waitFor();
    expect(await table.getByText("AI hypothesis").count()).toBe(0);
    await table.getByRole("button", { name: "Empty catch block" }).click();
    const detail = page.getByRole("complementary", { name: "Finding detail" });
    await detail.getByText("storage.setItem").waitFor();
    expect(await detail.getByRole("region", { name: "What is established" }).innerText()).toContain("Nothing was executed");

    // Classification is its own fact: it approves nothing.
    await detail.getByRole("button", { name: "Confirm", exact: true }).click();
    await detail.getByRole("region", { name: "Classification history" }).getByText("Confirmed by a person").waitFor();
    expect(await detail.getByRole("region", { name: "What is established" }).innerText()).toContain("Confirming a finding does not approve an issue");

    await detail.getByRole("button", { name: "Create issue proposal" }).click();
    const proposal = page.getByRole("complementary", { name: "Proposal detail" });
    const first = await proposal.getByLabel("Current revision").innerText();
    await proposal.getByLabel("Title").fill("Session save hides storage failures");
    await proposal.getByRole("button", { name: "Save edits" }).click();
    await expect.poll(() => proposal.getByLabel("Current revision").innerText()).not.toBe(first);
    await proposal.getByRole("button", { name: "Submit for review" }).click();
    const approve = proposal.getByRole("button", { name: "Approve this revision" });
    expect(await approve.isDisabled()).toBe(true);
    await proposal.getByRole("checkbox").check();
    await approve.click();
    await proposal.getByRole("region", { name: "Review actions" }).getByText(/^Approved/u).waitFor();
    expect(await proposal.getByRole("region", { name: "Publication requirements" }).innerText()).toContain("This release publishes nothing");

    // Editing approved text voids the approval, and a reason is required to reject.
    await proposal.getByLabel("Title").fill("Session save hides storage failures (edited)");
    await proposal.getByRole("button", { name: "Save edits" }).click();
    await proposal.getByRole("region", { name: "Invalidated approvals" }).waitFor();
    expect(await proposal.getByRole("button", { name: "Reject proposal" }).isDisabled()).toBe(true);
    await proposal.getByLabel("Reason for rejecting").fill("Tracked elsewhere");
    await proposal.getByRole("button", { name: "Reject proposal" }).click();
    await proposal.getByText(/^Rejected/u).first().waitFor();

    await navigation.getByRole("button", { name: "Architecture" }).click();
    await page.getByRole("table", { name: "Modules" }).getByText("src").waitFor();
    await navigation.getByRole("button", { name: "Overview" }).click();
    await page.getByRole("region", { name: "Deterministic coverage" }).waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1440);
    const screenshot = process.env["CONCLAVE_SCREENSHOT_COCKPIT"];
    if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
    expect(modelRequests).toEqual([]);
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>((done) => server.close(() => done())); await rm(parent, { recursive: true, force: true }); }
}, 90000);
