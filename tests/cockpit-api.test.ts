import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AuditReport } from "../src/domain/audit.js";
import type { ArchitectureView, AuditJobView, AuditPreflightView, ProjectView } from "../src/web/contracts.js";
import { ConclaveProductService } from "../src/web/product-service.js";
import { createConclaveWebServer } from "../src/web/server.js";
import type { FindingView } from "../src/workflow/triage-service.js";

const servers: ReturnType<typeof createConclaveWebServer>[] = [];
const directories: string[] = [];
// Assembled at run time so this file does not itself match a credential detector.
const PROVIDER_KEY = ["oc", "cockpit0api0test0key0value0000"].join("_");

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function cockpit(environment: NodeJS.ProcessEnv = {}): Promise<{ readonly origin: string; readonly project: ProjectView; readonly root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "conclave-cockpit-api-"));
  directories.push(parent);
  const root = join(parent, "repository");
  await mkdir(join(root, "src", "store"), { recursive: true });
  await writeFile(join(root, "src", "session.ts"), "import { read } from './store/disk.js';\nexport function load() {\n  try { return read(); } catch {}\n}\n");
  await writeFile(join(root, "src", "store", "disk.ts"), "export function read() {\n  return 1;\n}\n");
  const server = createConclaveWebServer({ product: new ConclaveProductService({ allowedRoot: parent, environment, environmentPath: join(parent, "settings.env") }) });
  servers.push(server);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP server address");
  const origin = `http://127.0.0.1:${String(address.port)}`;
  const project = await (await post(origin, "/api/projects/open", { path: root })).json() as ProjectView;
  return { origin, project, root };
}

function post(origin: string, path: string, payload: unknown, headers: Readonly<Record<string, string>> = {}): Promise<Response> {
  return fetch(`${origin}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: origin, ...headers }, body: JSON.stringify(payload) });
}

async function get<T>(origin: string, path: string): Promise<T> {
  return await (await fetch(`${origin}${path}`)).json() as T;
}

async function finished(origin: string, projectId: string): Promise<AuditJobView> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const { job } = await get<{ job: AuditJobView | null }>(origin, `/api/audit/status?projectId=${encodeURIComponent(projectId)}`);
    if (job !== null && job.state !== "running") return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("The audit did not finish");
}

describe("cockpit audit API", () => {
  it("runs a static audit as a job and serves its saved report and findings", async () => {
    const { origin, project } = await cockpit();
    const id = encodeURIComponent(project.id);

    expect(await get(origin, `/api/audit/latest?projectId=${id}`)).toEqual({ report: null });
    expect(await get(origin, `/api/audit/status?projectId=${id}`)).toEqual({ job: null });
    const started = await (await post(origin, "/api/audit/start", { projectId: project.id, mode: "static" })).json() as AuditJobView;
    expect(started).toMatchObject({ mode: "static", state: "running" });

    const job = await finished(origin, project.id);
    expect(job).toMatchObject({ id: started.id, state: "completed" });
    const { report } = await get<{ report: AuditReport }>(origin, `/api/audit/latest?projectId=${id}`);
    expect(report.trustBoundary).toEqual({ deterministic: true, modelCalls: 0, repositoryCodeExecuted: false, networkOperations: false });
    expect(report.semantic).toBeUndefined();
    const findings = await get<readonly FindingView[]>(origin, `/api/findings?projectId=${id}`);
    expect(findings.map((finding) => finding.ruleId)).toEqual(["discarded-error"]);
  });

  it("refuses a semantic audit without the explicit acknowledgement and starts no job", async () => {
    const { origin, project } = await cockpit({ CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: "opencode-go", CONCLAVE_MODEL: "deepseek-v4.1-flash", CONCLAVE_API_KEY: PROVIDER_KEY });

    for (const payload of [{ mode: "smart" }, { mode: "deep", acknowledgedModelCalls: "true" }, { mode: "smart", acknowledgedModelCalls: 1 }]) {
      const response = await post(origin, "/api/audit/start", { projectId: project.id, ...payload });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ error: { code: "acknowledgement_required" } });
    }
    expect(await get(origin, `/api/audit/status?projectId=${encodeURIComponent(project.id)}`)).toEqual({ job: null });
  });

  it("discloses provider, models and boundary before a semantic audit, without the credential", async () => {
    const { origin, project } = await cockpit({ CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: "opencode-go", CONCLAVE_MODEL: "deepseek-v4.1-flash", CONCLAVE_API_KEY: PROVIDER_KEY });
    const id = encodeURIComponent(project.id);

    const smart = await fetch(`${origin}/api/audit/preflight?projectId=${id}&mode=smart&verifierModel=kimi-k2.7-code&maxModelCalls=12`);
    const text = await smart.text();
    expect(text).not.toContain(PROVIDER_KEY);
    expect(JSON.parse(text) as AuditPreflightView).toMatchObject({
      mode: "smart",
      available: true,
      cachedRegions: 0,
      disclosure: {
        pipeline: "smart",
        discovery: { providerId: "opencode-go", modelId: "deepseek-v4.1-flash" },
        verifier: { modelId: "kimi-k2.7-code", independent: true, sameModelFamily: false },
        privacyBoundary: "external",
        providerHost: "opencode.ai",
        budget: { maxModelCalls: 12 },
      },
    });
    const sameModel = await get<AuditPreflightView>(origin, `/api/audit/preflight?projectId=${id}&mode=smart`);
    expect(sameModel.disclosure?.verifier).toMatchObject({ independent: false, sameModelFamily: true });
    const deep = await get<AuditPreflightView>(origin, `/api/audit/preflight?projectId=${id}&mode=deep`);
    expect(deep.disclosure).toMatchObject({ pipeline: "deep", challengeRoles: ["opencode-go/deepseek-v4.1-flash"] });
    expect(deep.disclosure?.verifier).toBeUndefined();
    expect(await get(origin, `/api/audit/preflight?projectId=${id}&mode=static`)).toEqual({ mode: "static", available: true, cachedRegions: 0 });
  });

  it("says a semantic mode is unavailable when no provider is configured, and rejects malformed options", async () => {
    const { origin, project } = await cockpit({ CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: "opencode-go" });
    const id = encodeURIComponent(project.id);

    const preflight = await get<AuditPreflightView>(origin, `/api/audit/preflight?projectId=${id}&mode=smart`);
    expect(preflight).toMatchObject({ available: false });
    expect(preflight.reason).toBeTruthy();
    const unavailable = await post(origin, "/api/audit/start", { projectId: project.id, mode: "smart", acknowledgedModelCalls: true });
    expect(await unavailable.json()).toMatchObject({ error: { code: "provider_unavailable" } });
    for (const query of ["mode=turbo", "mode=smart&maxModelCalls=0", "mode=smart&maxModelCalls=abc", "mode=smart&maxRegions=1.5"]) {
      expect((await fetch(`${origin}/api/audit/preflight?projectId=${id}&${query}`)).status).toBe(400);
    }
    expect((await post(origin, "/api/audit/start", { projectId: project.id, mode: "static", budget: { maxModelCalls: -4 } })).status).toBe(400);
  });

  it("keeps the loopback protections on the new routes", async () => {
    const { origin, project } = await cockpit();

    const foreign = await post(origin, "/api/audit/start", { projectId: project.id, mode: "static" }, { Origin: "https://attacker.example" });
    expect(foreign.status).toBe(403);
    const form = await fetch(`${origin}/api/audit/start`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: origin }, body: JSON.stringify({ projectId: project.id, mode: "static" }) });
    expect(form.status).toBe(400);
    expect(await get(origin, `/api/audit/status?projectId=${encodeURIComponent(project.id)}`)).toEqual({ job: null });
    const demo = await (await post(origin, "/api/projects/demo", {})).json() as ProjectView;
    expect(await (await post(origin, "/api/audit/start", { projectId: demo.id, mode: "static" })).json()).toMatchObject({ error: { code: "audit_unavailable" } });
  });

  it("describes the repository structure from the index", async () => {
    const { origin, project } = await cockpit();
    const view = await get<ArchitectureView>(origin, `/api/architecture?projectId=${encodeURIComponent(project.id)}`);

    expect(view).toMatchObject({ files: 2, languages: [{ language: "typescript", files: 2 }], omitted: { modules: 0, dependencies: 0 } });
    expect(view.modules.map((module) => module.name).sort()).toEqual(["src", "src/store"]);
    expect(view.dependencies).toEqual([{ from: "src", to: "src/store", relations: expect.any(Number) as unknown }]);
    expect(view.hubs.map((hub) => hub.path).sort()).toEqual(["src/session.ts", "src/store/disk.ts"]);
  });
});
