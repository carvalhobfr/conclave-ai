import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { expect, it } from "vitest";
import { createConclaveWebServer } from "../src/web/server.js";
import { ConclaveProductService } from "../src/web/product-service.js";

it.skipIf(process.env["CONCLAVE_BROWSER_TESTS"] !== "1")("distinguishes lookup observations from model judgments in the cockpit", async () => {
  const server = createConclaveWebServer({ product: new ConclaveProductService({ demoRoot: resolve("demo/auth-repository") }) });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const browser = await chromium.launch();
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No server port");
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${String(address.port)}/`);
    await page.getByRole("navigation", { name: "Workspace navigation" }).getByRole("button", { name: "Investigate", exact: true }).click();
    await page.getByRole("button", { name: "Run investigate", exact: true }).click();
    await page.getByRole("region", { name: "How to read this assessment" }).waitFor();
    const rejected = page.locator("article.claim.rejected");
    await rejected.locator("summary", { hasText: "How this was assessed" }).click();
    await rejected.getByText("Source lookup", { exact: true }).first().waitFor();
    await rejected.getByText("Model judgment", { exact: true }).waitFor();
    expect(await rejected.innerText()).toContain("Scripted demo assessment");
    const screenshotDirectory = process.env["CONCLAVE_ASSESSMENT_SCREENSHOT_DIR"];
    if (screenshotDirectory !== undefined) await mkdir(screenshotDirectory, { recursive: true });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(await page.getByRole("region", { name: "How to read this assessment" }).innerText()).toContain("Confirm behavior");
      if (screenshotDirectory !== undefined) await page.screenshot({ path: join(screenshotDirectory, `assessment-${String(width)}.png`), fullPage: true });
    }
    expect(errors).toEqual([]);
  } finally {
    await browser.close();
    await new Promise<void>((done) => server.close(() => done()));
  }
}, 60000);
