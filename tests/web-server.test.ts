import { execFile } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { ProjectView, RuntimeConfigurationResult, ValidationRunView } from "../src/web/contracts.js";
import { ConclaveProductService } from "../src/web/product-service.js";
import { createConclaveWebServer } from "../src/web/server.js";

const execFileAsync = promisify(execFile);
const servers: ReturnType<typeof createConclaveWebServer>[] = [];
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function listen(server: ReturnType<typeof createConclaveWebServer>): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Expected a TCP server address");
  return `http://127.0.0.1:${String(address.port)}`;
}

async function git(root: string, args: readonly string[]): Promise<void> {
  await execFileAsync("git", [...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Conclave Test",
      GIT_AUTHOR_EMAIL: "conclave@example.invalid",
      GIT_COMMITTER_NAME: "Conclave Test",
      GIT_COMMITTER_EMAIL: "conclave@example.invalid",
    },
  });
}

/** A real Git repository plus the allowed root the local server is confined to. */
async function repositoryFixture(): Promise<{ readonly parent: string; readonly root: string }> {
  const parent = await mkdtemp(join(tmpdir(), "conclave-web-routes-"));
  directories.push(parent);
  const root = join(parent, "repository");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "session.ts"), "export function restoreSession() { return false; }\n");
  await git(root, ["init", "-b", "master"]);
  await git(root, ["add", "--", "src/session.ts"]);
  await git(root, ["commit", "-m", "baseline"]);
  return { parent, root };
}

function postJson(origin: string, path: string, payload: unknown): Promise<Response> {
  return fetch(`${origin}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(payload),
  });
}

describe("Conclave web server runtime settings", () => {
  it("rejects foreign origins and never returns the submitted credential", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-web-server-"));
    const environment: NodeJS.ProcessEnv = {
      CONCLAVE_MODE: "local",
      CONCLAVE_PROVIDER: "ollama",
      CONCLAVE_MODEL: "qwen2.5-coder:3b",
      CONCLAVE_BASE_URL: "http://127.0.0.1:11434/v1",
      CONCLAVE_REASONING_PRESET: "local",
    };
    const product = new ConclaveProductService({
      environment,
      environmentPath: join(root, ".env"),
      diagnose: (config) => Promise.resolve({
        mode: config.mode,
        provider: config.providerSelection.provider,
        endpoint: config.providerSelection.baseUrl,
        modelConfigured: true,
        endpointReachable: true,
        inferenceAvailable: true,
        retrievalLocal: true,
        externalCallsDisabled: false,
        message: "Bounded provider inference succeeded.",
      }),
      fetchImplementation: () => Promise.resolve(new Response(JSON.stringify({
        data: [{ id: "kimi-k2.7-code" }, { id: "deepseek-v4-flash" }],
      }), { status: 200 })),
    });
    const server = createConclaveWebServer({ product });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP server address");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const payload = {
      mode: "api",
      provider: "opencode-go",
      model: "kimi-k2.7-code",
      baseUrl: "https://opencode.ai/zen/go/v1",
      reasoningPreset: "free-like",
      apiKey: "op-test-server-key-7v2m",
    };

    try {
      const rejected = await fetch(`${origin}/api/runtime`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
        body: JSON.stringify(payload),
      });
      expect(rejected.status).toBe(403);
      const rejection = JSON.parse(await rejected.text()) as { readonly error?: { readonly code?: string } };
      expect(rejection.error?.code).toBe("untrusted_origin");

      const accepted = await fetch(`${origin}/api/runtime`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify(payload),
      });
      expect(accepted.status).toBe(200);
      const result = JSON.parse(await accepted.text()) as RuntimeConfigurationResult;
      expect(result.saved).toBe(true);
      expect(result.runtime.provider).toBe("opencode-go");
      expect(result.runtime.credentialConfigured).toBe(true);
      expect(result.runtime.credentialHint).toBe("op••••••7v2m");
      expect(result.diagnostic.inferenceAvailable).toBe(true);
      expect(JSON.stringify(result)).not.toContain("op-test-server-key-7v2m");

      const modelsResponse = await fetch(`${origin}/api/runtime/models`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: origin },
        body: JSON.stringify({
          mode: "api",
          provider: "opencode-go",
          baseUrl: "https://opencode.ai/zen/go/v1",
        }),
      });
      expect(modelsResponse.status).toBe(200);
      const models = JSON.parse(await modelsResponse.text()) as { readonly models: readonly string[] };
      expect(models.models).toEqual(["kimi-k2.7-code", "deepseek-v4-flash"]);
      expect(JSON.stringify(models)).not.toContain("op-test-server-key-7v2m");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("guards every mutating route against foreign origins and preflight-free content types", async () => {
    const product = new ConclaveProductService({
      environment: {},
      diagnose: () => Promise.reject(new Error("The guard must reject before any product work runs")),
      fetchImplementation: () => Promise.reject(new Error("The guard must reject before any provider call runs")),
    });
    const server = createConclaveWebServer({ product });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected a TCP server address");
    const origin = `http://127.0.0.1:${String(address.port)}`;
    const routes = [
      "/api/projects/open",
      "/api/projects/demo",
      "/api/validate",
      "/api/run",
      "/api/runtime",
      "/api/runtime/models",
    ] as const;

    for (const route of routes) {
      const foreignOrigin = await fetch(`${origin}${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
        body: JSON.stringify({ path: "/tmp", projectId: "x", intent: "ask", query: "x" }),
      });
      expect(foreignOrigin.status).toBe(403);
      const rejection = JSON.parse(await foreignOrigin.text()) as { readonly error?: { readonly code?: string } };
      expect(rejection.error?.code).toBe("untrusted_origin");

      // A simple content type is what lets a cross-site POST skip the preflight entirely.
      const simpleRequest = await fetch(`${origin}${route}`, {
        method: "POST",
        headers: { "Content-Type": "text/plain", Origin: origin },
        body: JSON.stringify({ path: "/tmp", projectId: "x", intent: "ask", query: "x" }),
      });
      expect(simpleRequest.status).toBe(400);
      const contentTypeRejection = JSON.parse(await simpleRequest.text()) as { readonly error?: { readonly code?: string } };
      expect(contentTypeRejection.error?.code).toBe("invalid_content_type");
    }
  });
});

describe("Conclave web server routes", () => {
  it("serves health and runtime state without a project", async () => {
    const origin = await listen(createConclaveWebServer({
      product: new ConclaveProductService({ environment: {} }),
    }));

    const health = await fetch(`${origin}/api/health`);
    expect(health.status).toBe(200);
    expect(health.headers.get("cache-control")).toBe("no-store");
    expect(health.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await health.json()).toEqual({ ok: true });

    const runtime = await fetch(`${origin}/api/runtime`);
    expect(runtime.status).toBe(200);
    expect(await runtime.json()).toEqual(expect.objectContaining({ available: expect.any(Boolean) as boolean }));
  });

  it("opens a repository, reviews it, and reads back graph and history over HTTP", async () => {
    const { parent, root } = await repositoryFixture();
    const origin = await listen(createConclaveWebServer({
      product: new ConclaveProductService({ allowedRoot: parent, environment: {} }),
    }));

    const opened = await postJson(origin, "/api/projects/open", { path: root });
    expect(opened.status).toBe(200);
    const project = await opened.json() as ProjectView;
    expect(project.id).toEqual(expect.any(String));

    await writeFile(
      join(root, "src", "session.ts"),
      "export function restoreSession() { return true; }\nexport function restoredOverHttp() { return true; }\n",
    );

    const validated = await postJson(origin, "/api/validate", {
      projectId: project.id,
      source: { kind: "working" },
      objective: "Restore the session over the local HTTP API.",
      contract: {
        claims: [{
          id: "http-symbol",
          statement: "restoredOverHttp exists in the reviewed change.",
          check: { kind: "symbol-exists", symbol: "restoredOverHttp", expectation: "present" },
        }],
      },
    });
    expect(validated.status).toBe(200);
    const review = await validated.json() as ValidationRunView;
    expect(review.report.claims[0]?.outcome).toBe("supported");
    expect(review.report.trustBoundary.reasoningModelCalls).toBe(0);

    const graph = await fetch(`${origin}/api/graph?projectId=${encodeURIComponent(project.id)}&symbol=restoreSession`);
    expect(graph.status).toBe(200);
    expect(await graph.json()).toEqual(expect.objectContaining({ query: "restoreSession" }));

    const history = await fetch(`${origin}/api/history?projectId=${encodeURIComponent(project.id)}`);
    expect(history.status).toBe(200);
    expect(Array.isArray(await history.json())).toBe(true);
  });

  it("accepts every documented change source and names the ones it does not", async () => {
    const { parent, root } = await repositoryFixture();
    const origin = await listen(createConclaveWebServer({
      product: new ConclaveProductService({ allowedRoot: parent, environment: {} }),
    }));
    const project = await (await postJson(origin, "/api/projects/open", { path: root })).json() as ProjectView;
    const review = (source: unknown): Promise<Response> =>
      postJson(origin, "/api/validate", { projectId: project.id, source, objective: "Objective." });

    for (const source of [
      { kind: "working" },
      { kind: "workspace", base: "master" },
      { kind: "branch", base: "master" },
      { kind: "branch", base: "master", head: "master" },
      // Opening the project writes Conclave's own index cache under .conclave/, which Git
      // reports as untracked. `staged` must not trip on that: the change collector excludes
      // Conclave's own artifacts from every comparison, so this succeeds like the others.
      { kind: "staged" },
    ]) {
      expect((await review(source)).status, `${JSON.stringify(source)} must be accepted`).toBe(200);
    }

    const unsupported = await review({ kind: "cherry-pick" });
    expect(unsupported.status).toBe(400);
    expect(await unsupported.json()).toEqual({
      error: expect.objectContaining({ code: "invalid_change_source" }) as unknown,
    });

    const missingBase = await review({ kind: "branch" });
    expect(missingBase.status).toBe(400);
    expect(await missingBase.json()).toEqual({
      error: expect.objectContaining({ code: "invalid_request", message: "Base branch is required." }) as unknown,
    });
  });

  it("rejects a malformed or oversized request body", async () => {
    const origin = await listen(createConclaveWebServer({
      product: new ConclaveProductService({ environment: {} }),
    }));
    const send = (body: string): Promise<Response> => fetch(`${origin}/api/projects/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body,
    });

    expect(await (await send("{ not json")).json()).toEqual({
      error: expect.objectContaining({ code: "invalid_json" }) as unknown,
    });
    expect(await (await send(JSON.stringify(["array"]))).json()).toEqual({
      error: expect.objectContaining({ code: "invalid_request" }) as unknown,
    });
    expect(await (await send(JSON.stringify({ path: "   " }))).json()).toEqual({
      error: expect.objectContaining({ message: "Repository path is required." }) as unknown,
    });
    expect(await (await send(JSON.stringify({ path: "x".repeat(70_000) }))).json()).toEqual({
      error: expect.objectContaining({ code: "body_too_large" }) as unknown,
    });
  });

  it("refuses a repository outside the configured allowed root", async () => {
    const { parent } = await repositoryFixture();
    const origin = await listen(createConclaveWebServer({
      product: new ConclaveProductService({ allowedRoot: join(parent, "repository"), environment: {} }),
    }));

    const denied = await postJson(origin, "/api/projects/open", { path: tmpdir() });
    expect(denied.status).toBe(400);
    expect(await denied.json()).toEqual({
      error: expect.objectContaining({ code: "repository_denied" }) as unknown,
    });
  });

  it("restricts /api/run to the two read-only intents", async () => {
    const origin = await listen(createConclaveWebServer({
      product: new ConclaveProductService({ environment: {} }),
    }));

    const rejected = await postJson(origin, "/api/run", { projectId: "any", intent: "validate", query: "x" });
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: expect.objectContaining({ code: "invalid_intent" }) as unknown,
    });
  });

  it("answers an unroutable method with 405 rather than the web application", async () => {
    const origin = await listen(createConclaveWebServer({
      product: new ConclaveProductService({ environment: {} }),
    }));

    const response = await fetch(`${origin}/api/health`, { method: "DELETE" });
    expect(response.status).toBe(405);
    expect(await response.json()).toEqual({
      error: expect.objectContaining({ code: "method_not_allowed" }) as unknown,
    });
  });

  it("serves the client bundle and keeps traversal inside the static root", async () => {
    const staticRoot = await mkdtemp(join(tmpdir(), "conclave-web-static-"));
    directories.push(staticRoot);
    await writeFile(join(staticRoot, "index.html"), "<main>cockpit</main>");
    await writeFile(join(staticRoot, "app.css"), ".cockpit { color: red; }");
    const origin = await listen(createConclaveWebServer({
      staticRoot,
      product: new ConclaveProductService({ environment: {} }),
    }));

    const stylesheet = await fetch(`${origin}/app.css`);
    expect(stylesheet.status).toBe(200);
    expect(stylesheet.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await stylesheet.text()).toContain(".cockpit");

    // Unknown client routes and traversal attempts both fall back to the application shell.
    for (const path of ["/", "/history", "/../../etc/passwd", "/%2e%2e%2f%2e%2e%2fetc%2fpasswd"]) {
      const response = await fetch(`${origin}${path}`);
      expect(response.status, `${path} must resolve inside the static root`).toBe(200);
      expect(await response.text()).toBe("<main>cockpit</main>");
    }

    const head = await fetch(`${origin}/app.css`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("maps an unexpected product failure to a 500 without leaking its message", async () => {
    const product = new ConclaveProductService({ environment: {} });
    Object.defineProperty(product, "runtime", {
      value: () => { throw new Error("internal detail that must not reach the browser"); },
    });
    const origin = await listen(createConclaveWebServer({ product }));

    const response = await fetch(`${origin}/api/runtime`);
    expect(response.status).toBe(500);
    const payload = await response.text();
    expect(payload).not.toContain("internal detail");
    expect(JSON.parse(payload)).toEqual({
      error: expect.objectContaining({ code: "internal_error" }) as unknown,
    });
  });
});

describe("DNS rebinding", () => {
  it("answers only requests addressed to a loopback host", async () => {
    const origin = await listen(createConclaveWebServer({ product: new ConclaveProductService() }));
    const port = Number(new URL(origin).port);
    const get = (host: string, path: string) => new Promise<number>((resolvePromise, reject) => {
      const outgoing = httpRequest({ host: "127.0.0.1", port, path, headers: { Host: host } }, (incoming) => {
        incoming.resume();
        resolvePromise(incoming.statusCode ?? 0);
      });
      outgoing.once("error", reject);
      outgoing.end();
    });
    expect(await get(`attacker.example:${String(port)}`, "/api/runtime")).toBe(403);
    expect(await get(`attacker.example:${String(port)}`, "/")).toBe(403);
    expect(await get(`127.0.0.1:${String(port)}`, "/api/health")).toBe(200);
    expect(await get(`localhost:${String(port)}`, "/api/health")).toBe(200);
  });
});
