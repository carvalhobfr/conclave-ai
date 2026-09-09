import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { it, expect } from "vitest";
import { createConclaveWebServer } from "../src/web/server.js";
import { ConclaveProductService } from "../src/web/product-service.js";

it.skipIf(process.env["CONCLAVE_BROWSER_TESTS"] !== "1")("saves criteria, reloads them and reviews the real change on mobile", async () => {
  const root = await mkdtemp(join(tmpdir(), "conclave-cockpit-browser-"));
  const execute = promisify(execFile);
  await writeFile(join(root, "feature.ts"), "export const value = 1;\n");
  for (const args of [["init", "-b", "master"], ["add", "feature.ts"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"]]) await execute("git", args, { cwd: root });
  await writeFile(join(root, "feature.ts"), "export const value = 2;\n");
  const server = createConclaveWebServer({ product: new ConclaveProductService({ allowedRoot: root }) });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No server port");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${String(address.port)}/?repository=${encodeURIComponent(root)}`);
    await page.getByRole("button", { name: "Add criterion", exact: true }).click();
    await page.getByLabel(/Expected result/u).fill("Survives reload");
    await page.getByLabel("Verification plan", { exact: true }).fill("Save, reload, read");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "Save criteria", exact: true }).click();
    await page.getByText("Criteria saved for future reviews.", { exact: true }).waitFor();
    await page.reload();
    await page.getByLabel(/Expected result/u).waitFor();
    expect(await page.getByLabel(/Expected result/u).inputValue()).toBe("Survives reload");
    expect(await page.getByRole("checkbox").isChecked()).toBe(true);
    await page.getByRole("button", { name: "Review change", exact: true }).click();
    await page.getByRole("region", { name: "Criteria results" }).waitFor();
    expect(await page.getByRole("region", { name: "Criteria results" }).innerText()).toContain("NOT VERIFIED");
    const screenshot = process.env["CONCLAVE_SCREENSHOT"];
    if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    await page.getByRole("tab", { name: "Findings", exact: true }).click();
    await page.getByRole("region", { name: "Finding feedback" }).getByLabel("Reason", { exact: true }).fill("Reviewed the changed declaration");
    await page.getByRole("button", { name: "Save feedback", exact: true }).click();
    await page.getByText("Feedback saved locally. The review verdict is unchanged.", { exact: true }).waitFor();
    expect(errors).toEqual([]);
  } finally { await browser.close(); await new Promise<void>((done) => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
}, 60000);
