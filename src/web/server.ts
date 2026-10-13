import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConclaveEnvironment } from "../config/environment-file.js";
import { FINDING_DISPOSITIONS, FINDING_LIFECYCLE_STATES } from "../domain/finding-ledger.js";
import { PROPOSAL_STATUSES } from "../domain/issue-proposal.js";
import type { ChangeSource } from "../domain/validation.js";
import type { ProposalEdit } from "../validation/issue-proposal.js";
import type { FindingFilter } from "../workflow/triage-service.js";
import { AUDIT_MODES, REASONING_ROLE_NAMES, type AuditStartRequest, type ConfigurableProviderId, type ReasoningRoleName, type RoleModelChoice, type RuntimeConfigurationRequest, type RuntimeModelDiscoveryRequest } from "./contracts.js";
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

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new ProductServiceError("invalid_request", `${label} must be text.`, "Provide text or leave it out.");
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], label: string): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) throw new ProductServiceError("invalid_request", `${label} must be one of: ${allowed.join(", ")}.`, "Select a supported value.");
  return value as T;
}

function listOf<T extends string>(value: string | null, allowed: readonly T[], label: string): readonly T[] | undefined {
  if (value === null || value === "") return undefined;
  return value.split(",").map((item) => oneOf(item.trim(), allowed, label));
}

function findingFilter(parameters: URLSearchParams): FindingFilter {
  const states = listOf(parameters.get("state"), FINDING_LIFECYCLE_STATES, "State");
  const dispositions = listOf(parameters.get("disposition"), FINDING_DISPOSITIONS, "Disposition");
  const severity = parameters.get("severity");
  const rule = parameters.get("rule");
  const path = parameters.get("path");
  const baselined = parameters.get("baselined");
  return {
    ...(states === undefined ? {} : { states }),
    ...(dispositions === undefined ? {} : { dispositions }),
    ...(severity === null ? {} : { severity: oneOf(severity, ["high", "medium", "low"] as const, "Severity") }),
    ...(rule === null ? {} : { ruleId: rule }),
    ...(path === null ? {} : { path }),
    suppressed: parameters.get("suppressed") === "true",
    ...(baselined === null ? {} : { baselined: baselined === "true" }),
  };
}

function proposalEdit(payload: Record<string, unknown>): ProposalEdit {
  const title = optionalString(payload["title"], "Title");
  const text = optionalString(payload["body"], "Body");
  const labels = payload["labels"];
  if (labels !== undefined && (!Array.isArray(labels) || labels.some((label) => typeof label !== "string"))) throw new ProductServiceError("invalid_request", "Labels must be a list of text values.", "Provide labels as a list.");
  return { ...(title === undefined ? {} : { title }), ...(text === undefined ? {} : { body: text }), ...(labels === undefined ? {} : { labels: labels as readonly string[] }) };
}

const BUDGET_FIELDS = ["maxModelCalls", "maxInputTokens", "maxOutputTokens", "maxDurationMs", "maxRegions", "maxInvestigations"] as const;

/** Budget and model overrides of an audit request. Anything not a bounded whole number or a model name is refused. */
function auditOptions(source: (name: string) => unknown): Pick<AuditStartRequest, "budget" | "discoveryModel" | "verifierModel"> {
  const budget: Record<string, number> = {};
  for (const field of BUDGET_FIELDS) {
    const raw = source(field);
    if (raw === undefined || raw === null || raw === "") continue;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < (field === "maxInvestigations" ? 0 : 1) || value > 100_000_000) throw new ProductServiceError("invalid_request", `${field} must be a whole number.`, "Enter a positive whole number or leave it empty.");
    budget[field] = value;
  }
  const model = (name: string): string | undefined => {
    const raw = source(name);
    if (raw === undefined || raw === null || raw === "") return undefined;
    // eslint-disable-next-line no-control-regex
    if (typeof raw !== "string" || raw.length > 200 || /[\u0000-\u001f]/u.test(raw)) throw new ProductServiceError("invalid_request", `${name} must be a model name.`, "Enter a model name or leave it empty.");
    return raw.trim();
  };
  const [discoveryModel, verifierModel] = [model("discoveryModel"), model("verifierModel")];
  return { ...(Object.keys(budget).length === 0 ? {} : { budget }), ...(discoveryModel === undefined ? {} : { discoveryModel }), ...(verifierModel === undefined ? {} : { verifierModel }) };
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
    ...roleModelOptions(payload),
  };
}

function modelName(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > 200) {
    throw new ProductServiceError("invalid_runtime_configuration", `${label} must be a model name.`, "Choose a model for this role.");
  }
  return value.trim();
}

function roleModelOptions(payload: Record<string, unknown>): Pick<RuntimeConfigurationRequest, "roles" | "fallbackModel"> {
  const rawRoles = payload["roles"];
  const rawFallback = payload["fallbackModel"];
  const options: { roles?: Partial<Record<ReasoningRoleName, RoleModelChoice>>; fallbackModel?: string } = {};
  if (rawRoles !== undefined) {
    if (typeof rawRoles !== "object" || rawRoles === null || Array.isArray(rawRoles)) {
      throw new ProductServiceError("invalid_runtime_configuration", "Role models must be an object.", "Choose a model for each role.");
    }
    const roles: Partial<Record<ReasoningRoleName, RoleModelChoice>> = {};
    for (const [role, choice] of Object.entries(rawRoles as Record<string, unknown>)) {
      if (!(REASONING_ROLE_NAMES as readonly string[]).includes(role)) {
        throw new ProductServiceError("invalid_runtime_configuration", `Unknown reasoning role: ${role}.`, "Use investigator, skeptic, architect, verifier or judge.");
      }
      if (typeof choice !== "object" || choice === null || Array.isArray(choice)) {
        throw new ProductServiceError("invalid_runtime_configuration", `Model for ${role} must be an object.`, "Choose a model for this role.");
      }
      const entry = choice as Record<string, unknown>;
      const provider = entry["provider"];
      if (provider !== undefined && (typeof provider !== "string" || !CONFIGURABLE_PROVIDERS.has(provider as ConfigurableProviderId))) {
        throw new ProductServiceError("invalid_runtime_configuration", `Provider for ${role} is not configurable from this cockpit.`, "Select a supported provider.");
      }
      roles[role as ReasoningRoleName] = {
        ...(provider === undefined ? {} : { provider: provider as ConfigurableProviderId }),
        model: modelName(entry["model"], `Model for ${role}`),
      };
    }
    options.roles = roles;
  }
  if (rawFallback !== undefined) options.fallbackModel = modelName(rawFallback, "Fallback model");
  return options;
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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

/**
 * Every request, reads included, must name a loopback host. A page on another site can rebind
 * its own DNS name to 127.0.0.1; the browser then treats this server as same-origin with that
 * page and lets it read repository history, graph evidence, and runtime details. The Host
 * header still carries the attacker's name, so rejecting it closes that path.
 */
function assertLoopbackHost(request: IncomingMessage): void {
  const host = request.headers.host;
  let hostname: string | undefined;
  try {
    hostname = host === undefined ? undefined : new URL(`http://${host}`).hostname;
  } catch {
    hostname = undefined;
  }
  if (hostname === undefined || !LOOPBACK_HOSTS.has(hostname)) {
    throw new ProductServiceError("untrusted_host", "This local Conclave server only answers loopback addresses.", "Open the cockpit at http://127.0.0.1 with `conclave open .`.");
  }
}

function assertLocalBrowserOrigin(request: IncomingMessage): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  try {
    if (origin === undefined || host === undefined) throw new Error("missing origin");
    const parsedOrigin = new URL(origin);
    const parsedHost = new URL(`http://${host}`);
    if (parsedOrigin.protocol !== "http:" || parsedOrigin.host !== parsedHost.host || !LOOPBACK_HOSTS.has(parsedOrigin.hostname)) {
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
      assertLoopbackHost(request);
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
      if (url.pathname === "/api/feedback" && request.method === "GET") { send(response, 200, await product.feedback(string(url.searchParams.get("projectId"), "Project"))); return; }
      if (url.pathname === "/api/feedback" && request.method === "POST") {
        const payload = await body(request);
        send(response, 200, await product.saveFeedback(string(payload["projectId"], "Project"), string(payload["reviewId"], "Review"), payload["feedback"])); return;
      }
      // Audit triage. Reads are GET; every change is a guarded JSON POST. No route publishes anything.
      if (url.pathname === "/api/audit/latest" && request.method === "GET") { send(response, 200, { report: await product.latestAudit(string(url.searchParams.get("projectId"), "Project")) }); return; }
      if (url.pathname === "/api/audit/status" && request.method === "GET") { send(response, 200, { job: product.auditStatus(string(url.searchParams.get("projectId"), "Project")) }); return; }
      if (url.pathname === "/api/audit/preflight" && request.method === "GET") {
        send(response, 200, await product.auditPreflight(string(url.searchParams.get("projectId"), "Project"), oneOf(url.searchParams.get("mode"), AUDIT_MODES, "Mode"), auditOptions((name) => url.searchParams.get(name)))); return;
      }
      // Starting an audit is a guarded JSON POST like every other change; a semantic mode also needs the explicit acknowledgement.
      if (url.pathname === "/api/audit/start" && request.method === "POST") {
        const payload = await body(request);
        const budget = isRecord(payload["budget"]) ? payload["budget"] : {};
        send(response, 200, product.startAudit(string(payload["projectId"], "Project"), {
          mode: oneOf(payload["mode"], AUDIT_MODES, "Mode"),
          acknowledgedModelCalls: payload["acknowledgedModelCalls"] === true,
          ...auditOptions((name) => (BUDGET_FIELDS as readonly string[]).includes(name) ? budget[name] : payload[name]),
        })); return;
      }
      if (url.pathname === "/api/architecture" && request.method === "GET") { send(response, 200, product.architecture(string(url.searchParams.get("projectId"), "Project"))); return; }
      if (url.pathname === "/api/audit/runs" && request.method === "GET") { send(response, 200, await product.auditRuns(string(url.searchParams.get("projectId"), "Project"))); return; }
      if (url.pathname === "/api/findings" && request.method === "GET") {
        send(response, 200, await product.findings(string(url.searchParams.get("projectId"), "Project"), findingFilter(url.searchParams))); return;
      }
      if (url.pathname === "/api/findings/detail" && request.method === "GET") {
        send(response, 200, await product.finding(string(url.searchParams.get("projectId"), "Project"), string(url.searchParams.get("id"), "Finding"))); return;
      }
      if (url.pathname === "/api/findings/classify" && request.method === "POST") {
        const payload = await body(request);
        send(response, 200, await product.classifyFinding(string(payload["projectId"], "Project"), string(payload["id"], "Finding"), oneOf(payload["classification"], FINDING_DISPOSITIONS, "Classification"), optionalString(payload["note"], "Note"))); return;
      }
      if (url.pathname === "/api/issues" && request.method === "GET") {
        const statuses = listOf(url.searchParams.get("status"), PROPOSAL_STATUSES, "Status");
        const findingId = url.searchParams.get("findingId");
        send(response, 200, await product.issueProposals(string(url.searchParams.get("projectId"), "Project"), { ...(statuses === undefined ? {} : { statuses }), ...(findingId === null ? {} : { findingId }) })); return;
      }
      if (url.pathname === "/api/issues/detail" && request.method === "GET") {
        send(response, 200, await product.issueProposal(string(url.searchParams.get("projectId"), "Project"), string(url.searchParams.get("id"), "Proposal"))); return;
      }
      if (url.pathname.startsWith("/api/issues/") && request.method === "POST") {
        const payload = await body(request);
        const project = string(payload["projectId"], "Project");
        switch (url.pathname.slice("/api/issues/".length)) {
          case "propose": send(response, 200, await product.proposeIssue(project, string(payload["findingId"], "Finding"), optionalString(payload["reason"], "Reason"))); return;
          case "edit": send(response, 200, await product.editIssueProposal(project, string(payload["id"], "Proposal"), proposalEdit(payload))); return;
          case "submit": send(response, 200, await product.submitIssueProposal(project, string(payload["id"], "Proposal"))); return;
          // The revision is required and is never defaulted to the current one: approving means approving what was read.
          case "approve": send(response, 200, await product.approveIssueProposal(project, string(payload["id"], "Proposal"), string(payload["revision"], "Revision"))); return;
          case "reject": send(response, 200, await product.rejectIssueProposal(project, string(payload["id"], "Proposal"), string(payload["reason"], "Reason"))); return;
          case "ready": send(response, 200, await product.markIssueProposalReady(project, string(payload["id"], "Proposal"))); return;
          case "refresh": send(response, 200, await product.refreshIssueProposal(project, string(payload["id"], "Proposal"))); return;
          default: throw new ProductServiceError("unknown_action", "This issue proposal action does not exist.", "Use propose, edit, submit, approve, reject, ready or refresh.");
        }
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
      send(response, known ? (error.code === "untrusted_host" || error.code === "untrusted_origin" ? 403 : 400) : 500, {
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
