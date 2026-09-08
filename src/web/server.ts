import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConclaveEnvironment } from "../config/environment-file.js";
import type { ChangeSource } from "../domain/validation.js";
import type { ConfigurableProviderId, RuntimeConfigurationRequest, RuntimeModelDiscoveryRequest } from "./contracts.js";
import { ConclaveProductService, ProductServiceError } from "./product-service.js";

const BODY_LIMIT_BYTES = 64_000;
const CONFIGURABLE_PROVIDERS = new Set<ConfigurableProviderId>(["openai", "openrouter", "anthropic", "opencode-go", "opencode-zen", "ollama", "lm-studio", "openai-compatible"]);
const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new ProductServiceError("invalid_body", "Request body must be byte data.", "Try the web application again.");
    const value: Uint8Array = chunk;
    size += value.byteLength;
    if (size > BODY_LIMIT_BYTES) throw new ProductServiceError("body_too_large", "Request body exceeds the local API limit.", "Submit a smaller request.");
    chunks.push(value);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ProductServiceError("invalid_json", "Request body must be valid JSON.", "Try again with a valid request.");
  }
  if (!isRecord(parsed)) throw new ProductServiceError("invalid_request", "Request body must be an object.", "Try again.");
  return parsed;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new ProductServiceError("invalid_request", `${label} is required.`, "Provide the missing value.");
  return value;
}

function runtimeConfiguration(payload: Record<string, unknown>): RuntimeConfigurationRequest {
  const mode = string(payload["mode"], "Runtime mode");
  if (mode !== "api" && mode !== "local") {
    throw new ProductServiceError("invalid_runtime_configuration", "Runtime mode must be API or local.", "Select a supported runtime mode.");
  }
  const provider = string(payload["provider"], "Provider");
  if (!CONFIGURABLE_PROVIDERS.has(provider as ConfigurableProviderId)) {
    throw new ProductServiceError("invalid_runtime_configuration", "Provider is not configurable from this cockpit.", "Select a supported provider.");
  }
  const reasoningPreset = string(payload["reasoningPreset"], "Reasoning preset");
  if (reasoningPreset !== "free-like" && reasoningPreset !== "full" && reasoningPreset !== "local") {
    throw new ProductServiceError("invalid_runtime_configuration", "Reasoning preset is invalid.", "Select fast, full, or local reasoning.");
  }
  const rawApiKey = payload["apiKey"];
  if (rawApiKey !== undefined && typeof rawApiKey !== "string") {
    throw new ProductServiceError("invalid_runtime_configuration", "API key must be text.", "Paste a valid provider key.");
  }
  if (typeof rawApiKey === "string" && rawApiKey.length > 8_192) {
    throw new ProductServiceError("invalid_runtime_configuration", "API key exceeds the local configuration limit.", "Paste a valid provider key.");
  }
  return {
    mode,
    provider: provider as ConfigurableProviderId,
    model: string(payload["model"], "Model"),
    baseUrl: string(payload["baseUrl"], "Provider endpoint"),
    reasoningPreset,
    ...(rawApiKey === undefined ? {} : { apiKey: rawApiKey }),
  };
}

function runtimeModelDiscovery(payload: Record<string, unknown>): RuntimeModelDiscoveryRequest {
  const mode = string(payload["mode"], "Runtime mode");
  if (mode !== "api" && mode !== "local") {
    throw new ProductServiceError("invalid_runtime_configuration", "Runtime mode must be API or local.", "Select a supported runtime mode.");
  }
  const provider = string(payload["provider"], "Provider");
  if (!CONFIGURABLE_PROVIDERS.has(provider as ConfigurableProviderId)) {
    throw new ProductServiceError("invalid_runtime_configuration", "Provider is not configurable from this cockpit.", "Select a supported provider.");
  }
  const rawApiKey = payload["apiKey"];
  if (rawApiKey !== undefined && typeof rawApiKey !== "string") {
    throw new ProductServiceError("invalid_runtime_configuration", "API key must be text.", "Paste a valid provider key.");
  }
  if (typeof rawApiKey === "string" && rawApiKey.length > 8_192) {
    throw new ProductServiceError("invalid_runtime_configuration", "API key exceeds the local configuration limit.", "Paste a valid provider key.");
  }
  return {
    mode,
    provider: provider as ConfigurableProviderId,
    baseUrl: string(payload["baseUrl"], "Provider endpoint"),
    ...(rawApiKey === undefined ? {} : { apiKey: rawApiKey }),
  };
}

function assertLocalBrowserOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  try {
    if (origin === undefined || host === undefined) throw new Error("missing origin");
    const parsedOrigin = new URL(origin);
    const parsedHost = new URL(`http://${host}`);
    const loopback = new Set(["127.0.0.1", "[::1]", "localhost"]);
    if (parsedOrigin.protocol !== "http:" || parsedOrigin.host !== parsedHost.host || !loopback.has(parsedOrigin.hostname)) {
      throw new Error("untrusted origin");
    }
  } catch {
    throw new ProductServiceError("untrusted_origin", "Runtime settings can only be changed from this local Conclave page.", "Open Settings from the loopback cockpit and try again.");
  }
}

/**
 * Every mutating route is guarded, not only the runtime settings. A cross-site POST with a
 * simple content type skips the preflight, so without both checks any page open in the same
 * browser could drive this loopback server: index a repository, spend the configured provider
 * key, and ship repository excerpts to that provider. The response stays unreadable to the
 * attacker, but the side effects are real.
 */
function assertLocalJsonPost(request: IncomingMessage): void {
  assertLocalBrowserOrigin(request);
  if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new ProductServiceError(
      "invalid_content_type",
      "This local API only accepts JSON requests.",
      "Use the local Conclave cockpit.",
    );
  }
}

function changeSource(value: unknown): ChangeSource {
  const parsed = isRecord(value) ? value : {};
  const kind = string(parsed["kind"], "Change source");
  switch (kind) {
    case "working":
    case "staged":
      return { kind };
    case "workspace":
      return { kind, base: string(parsed["base"], "Base branch") };
    case "branch":
      return {
        kind,
        base: string(parsed["base"], "Base branch"),
        ...(parsed["head"] === undefined ? {} : { head: string(parsed["head"], "Head branch") }),
      };
    case "commit":
      return { kind, commit: string(parsed["commit"], "Commit") };
    default:
      throw new ProductServiceError(
        "invalid_change_source",
        "Change source must be workspace, working, staged, branch, or commit.",
        "Select a supported Git comparison.",
      );
  }
}

function send(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

function safeStaticPath(root: string, pathname: string): string {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = resolve(root, requested);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return resolve(root, "index.html");
  return candidate;
}

export interface ConclaveWebServerOptions {
  readonly port?: number;
  readonly host?: string;
  readonly staticRoot?: string;
  readonly product?: ConclaveProductService;
}

export function createConclaveWebServer(options: ConclaveWebServerOptions = {}) {
  const product = options.product ?? new ConclaveProductService();
  const staticRoot = resolve(options.staticRoot ?? "dist/web-client");
  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "POST") assertLocalJsonPost(request);
      if (url.pathname === "/api/health" && request.method === "GET") { send(response, 200, { ok: true }); return; }
      if (url.pathname === "/api/runtime" && request.method === "GET") { send(response, 200, product.runtime()); return; }
      if (url.pathname === "/api/runtime" && request.method === "POST") {
        send(response, 200, await product.configureRuntime(runtimeConfiguration(await body(request))));
        return;
      }
      if (url.pathname === "/api/runtime/models" && request.method === "POST") {
        send(response, 200, await product.discoverModels(runtimeModelDiscovery(await body(request))));
        return;
      }
      if (url.pathname === "/api/projects/demo" && request.method === "POST") { send(response, 200, await product.openDemo()); return; }
      if (url.pathname === "/api/projects/open" && request.method === "POST") {
        const payload = await body(request);
        send(response, 200, await product.openLocal(string(payload["path"], "Repository path")));
        return;
      }
      if (url.pathname === "/api/acceptance" && request.method === "GET") {
        send(response, 200, await product.acceptance(string(url.searchParams.get("projectId"), "Project"))); return;
      }
      if (url.pathname === "/api/acceptance" && request.method === "POST") {
        const payload = await body(request);
        const revision = payload["revision"];
        if (revision !== null && typeof revision !== "string") throw new Error("Saved revision is required");
        send(response, 200, await product.saveAcceptance(string(payload["projectId"], "Project"), payload["contract"], revision)); return;
      }
      if (url.pathname === "/api/validate" && request.method === "POST") {
        const payload = await body(request);
        send(response, 200, await product.validate(
          string(payload["projectId"], "Project"),
          changeSource(payload["source"]),
          string(payload["objective"], "Objective"),
          payload["contract"],
          { ...(typeof payload["previousReviewId"] === "string" ? { previousReviewId: payload["previousReviewId"] } : {}), ...(payload["receipts"] === undefined ? {} : { receipts: payload["receipts"] }), newSeries: payload["newSeries"] === true },
        ));
        return;
      }
      if (url.pathname === "/api/run" && request.method === "POST") {
        const payload = await body(request);
        const intent = string(payload["intent"], "Intent");
        if (intent !== "ask" && intent !== "investigate") throw new ProductServiceError("invalid_intent", "This endpoint supports Ask and Investigate only.", "Select an explicit read-only intent.");
        send(response, 200, await product.run(string(payload["projectId"], "Project"), intent, string(payload["query"], "Question")));
        return;
      }
      if (url.pathname === "/api/graph" && request.method === "GET") {
        send(response, 200, product.graph(string(url.searchParams.get("projectId"), "Project"), string(url.searchParams.get("symbol"), "Symbol")));
        return;
      }
      if (url.pathname === "/api/history" && request.method === "GET") {
        send(response, 200, await product.history(string(url.searchParams.get("projectId"), "Project")));
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") { send(response, 405, { error: { code: "method_not_allowed", message: "Method not allowed.", action: "Use the local web application." } }); return; }
      let path = safeStaticPath(staticRoot, url.pathname);
      const details = await stat(path).catch(() => undefined);
      if (details === undefined || !details.isFile()) path = resolve(staticRoot, "index.html");
      const content = await readFile(path);
      response.writeHead(200, {
        "Content-Type": CONTENT_TYPES[extname(path)] ?? "application/octet-stream",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(request.method === "HEAD" ? undefined : content);
    } catch (error) {
      const known = error instanceof ProductServiceError;
      send(response, known ? 400 : 500, {
        error: {
          code: known ? error.code : "internal_error",
          message: known ? error.message : "Conclave local server could not complete this request.",
          action: known ? error.action : "Check the local server logs and retry.",
        },
      });
    }
  };
  return createServer((request, response) => { void handler(request, response); });
}

const isEntry = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isEntry) {
  loadConclaveEnvironment();
  const port = Number(process.env["CONCLAVE_WEB_PORT"] ?? "4317");
  createConclaveWebServer().listen(port, "127.0.0.1", () => {
    console.log(`Conclave web server listening on http://127.0.0.1:${String(port)}`);
  });
}
