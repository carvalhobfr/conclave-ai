import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { parseSmokePlan, runSmokePlan } from "../src/execution/browser-smoke.js";

it("rejects external targets, cross-origin navigation and assertion-free plans", () => {
  const plan = { version: 1, id: "save", criterionIds: [], baseURL: "http://127.0.0.1:1234", steps: [{ action: "assert-value", selector: "input", value: "x" }] };
  expect(() => parseSmokePlan({ ...plan, baseURL: "https://example.com" })).toThrow("loopback");
  expect(() => parseSmokePlan({ ...plan, steps: [{ action: "open", value: "https://example.com" }] })).toThrow("origin");
  expect(() => parseSmokePlan({ ...plan, steps: [{ action: "reload" }] })).toThrow("assertion");
});

describe.skipIf(process.env["CONCLAVE_BROWSER_TESTS"] !== "1")("versioned browser persistence fixtures", () => {
  it.each(["saved", "lost", "failed"])("detects the %s persistence outcome", async (mode) => {
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<label>Preference<input id="preference"></label><button id="save">Save</button><span id="status"></span><script>const preference=document.querySelector("#preference");const save=document.querySelector("#save");const result=document.querySelector("#status");preference.value=localStorage.getItem('preference')||'';save.onclick=()=>{${mode === "saved" ? "localStorage.setItem('preference',preference.value);" : ""}result.textContent='${mode === "failed" ? "Failed" : "Saved"}';};</script>`);
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing fixture port");
    try {
      const plan = parseSmokePlan({ version: 1, id: "preference", baseURL: `http://127.0.0.1:${String(address.port)}`, criterionIds: [], steps: [{ action: "fill", selector: "#preference", value: "dark" }, { action: "click", selector: "#save" }, { action: "assert-text", selector: "#status", value: "Saved" }, { action: "reload" }, { action: "assert-value", selector: "#preference", value: "dark" }] });
      const result = await runSmokePlan(plan);
      expect(result.exitCode).toBe(mode === "saved" ? 0 : 1);
      if (mode !== "saved") expect(result.summary).toContain(mode === "failed" ? "step 3" : "step 5");
    } finally { await new Promise<void>((done) => server.close(() => done())); }
  }, 30000);
});
