import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { RuntimeConfig } from "../src/domain/execution-mode.js";
import type { ProviderDiagnostics } from "../src/providers/provider-diagnostics.js";
import { ConclaveProductService } from "../src/web/product-service.js";

const demoRoot = resolve("demo/auth-repository");

function service(): ConclaveProductService {
  return new ConclaveProductService({ demoRoot, allowedRoot: resolve("demo") });
}

describe("ConclaveProductService", () => {
  it("runs deterministic Ask and exposes graph-backed evidence", async () => {
    const product = service();
    const project = await product.openDemo();
    const run = await product.run(project.id, "ask", "Where is bootstrapSession called?");

    expect(run.status).toBe("completed");
    expect(run.trace.find((item) => item.role === "skeptic")?.status).toBe("skipped");
    expect(run.evidence[0]).toEqual(expect.objectContaining({ path: "src/auth/AuthProvider.ts" }));
    expect(run.graph.status).toBe("resolved");
    expect(run.retrieval.approximateTokens).toBeGreaterThan(0);
  });

  it("keeps rejected hypotheses visible for Investigate", async () => {
    const product = service();
    const project = await product.openDemo();
    const run = await product.run(project.id, "investigate", "Why might authentication disappear after refresh?");

    expect(run.claims).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: "rejected", statement: "The token is never persisted." })]),
    );
    expect(run.trace.every((item) => item.status === "ran")).toBe(true);
  });

  it("refuses local paths outside the server configured root", async () => {
    await expect(service().openLocal(resolve("."))).rejects.toMatchObject({ code: "repository_denied" });
  });

  it("persists a selected OpenCode Go runtime, updates every role, and returns only safe diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-web-runtime-"));
    const environment: NodeJS.ProcessEnv = {
      CONCLAVE_MODE: "local",
      CONCLAVE_PROVIDER: "ollama",
      CONCLAVE_MODEL: "qwen2.5-coder:3b",
      CONCLAVE_BASE_URL: "http://127.0.0.1:11434/v1",
      CONCLAVE_REASONING_PRESET: "local",
    };
    const diagnose = vi.fn((config: RuntimeConfig): Promise<ProviderDiagnostics> => Promise.resolve({
      mode: config.mode,
      provider: config.providerSelection.provider,
      endpoint: config.providerSelection.baseUrl,
      modelConfigured: true,
      endpointReachable: true,
      inferenceAvailable: true,
      retrievalLocal: true as const,
      externalCallsDisabled: false,
      message: "Bounded provider inference succeeded.",
    }));
    try {
      const product = new ConclaveProductService({
        environment,
        environmentPath: join(root, ".env"),
        diagnose,
      });
      const result = await product.configureRuntime({
        mode: "api",
        provider: "opencode-go",
        model: "kimi-k2.7-code",
        baseUrl: "https://opencode.ai/zen/go/v1",
        reasoningPreset: "free-like",
        apiKey: "op-test-go-key-9x7z",
      });

      expect(result).toMatchObject({
        saved: true,
        credentialUpdated: true,
        runtime: {
          active: "api",
          provider: "opencode-go",
          model: "kimi-k2.7-code",
          credentialConfigured: true,
          credentialHint: "op••••••9x7z",
        },
        diagnostic: { inferenceAvailable: true },
      });
      expect(result.runtime.roles.every((role) => role.provider === "opencode-go" && role.model === "kimi-k2.7-code")).toBe(true);
      expect(JSON.stringify(result)).not.toContain("op-test-go-key-9x7z");
      expect(environment["CONCLAVE_API_KEY"]).toBe("op-test-go-key-9x7z");
      const contents = await readFile(join(root, ".env"), "utf8");
      expect(contents).toContain('CONCLAVE_PROVIDER="opencode-go"');
      expect(contents).toContain('CONCLAVE_MODEL="kimi-k2.7-code"');
      expect(diagnose).toHaveBeenCalledOnce();

      const mixed = await product.configureRuntime({
        mode: "api",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        baseUrl: "https://opencode.ai/zen/go/v1",
        reasoningPreset: "full",
        roles: { judge: { provider: "opencode-zen", model: "jev-1.13" } },
        fallbackModel: "hy3",
      });
      expect(mixed.runtime.roles).toEqual(expect.arrayContaining([
        expect.objectContaining({ role: "judge", provider: "opencode-zen", model: "jev-1.13" }),
        expect.objectContaining({ role: "investigator", provider: "opencode-go", model: "deepseek-v4.1-flash" }),
      ]));
      const mixedContents = await readFile(join(root, ".env"), "utf8");
      expect(mixedContents).toContain('CONCLAVE_JUDGE_PROVIDER="opencode-zen"');
      expect(mixedContents).toContain('CONCLAVE_FALLBACK_MODEL="hy3"');
      await expect(product.configureRuntime({
        mode: "api",
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        baseUrl: "https://opencode.ai/zen/go/v1",
        reasoningPreset: "full",
        roles: { judge: { provider: "openrouter", model: "x" } },
      })).rejects.toThrow(/same vendor credential/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("discovers selectable models without returning the provider credential", async () => {
    const environment: NodeJS.ProcessEnv = {
      CONCLAVE_MODE: "api",
      CONCLAVE_PROVIDER: "opencode-go",
      CONCLAVE_MODEL: "kimi-k2.7-code",
      CONCLAVE_BASE_URL: "https://opencode.ai/zen/go/v1",
      CONCLAVE_API_KEY: "test-model-list-key",
    };
    const product = new ConclaveProductService({
      environment,
      fetchImplementation: (input, init) => {
        const endpoint = input instanceof URL ? input.toString() : input instanceof Request ? input.url : input;
        expect(endpoint).toBe("https://opencode.ai/zen/go/v1/models");
        expect(init?.headers).toEqual({ authorization: "Bearer test-model-list-key" });
        return Promise.resolve(new Response(JSON.stringify({
          data: [{ id: "kimi-k2.7-code" }, { id: "deepseek-v4-flash" }, { id: "kimi-k2.7-code" }],
        }), { status: 200 }));
      },
    });

    const result = await product.discoverModels({
      mode: "api",
      provider: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
    });

    expect(result).toEqual({
      provider: "opencode-go",
      endpoint: "https://opencode.ai/zen/go/v1/models",
      models: ["kimi-k2.7-code", "deepseek-v4-flash"],
    });
    expect(JSON.stringify(result)).not.toContain("test-model-list-key");
  });
});
