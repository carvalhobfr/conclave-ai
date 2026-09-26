import { describe, expect, it, vi } from "vitest";

import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { ProviderError } from "../src/domain/provider.js";
import { FakeProvider } from "../src/providers/fake-provider.js";
import { AnthropicProvider } from "../src/providers/anthropic-provider.js";
import { OpenAiCompatibleProvider } from "../src/providers/openai-compatible-provider.js";
import { createProvider, createRoleProviders } from "../src/providers/provider-factory.js";
import { diagnoseProvider } from "../src/providers/provider-diagnostics.js";
import { parseJudgeOutput } from "../src/reasoning/structured-outputs.js";
import { EnvironmentCredentialSource } from "../src/storage/environment-credential-source.js";

describe("providers", () => {
  it("uses a fake provider for deterministic tests", async () => {
    const provider = new FakeProvider((request) => ({
      provider: "fake",
      model: request.model,
      text: "structured fake",
    }));

    await expect(
      provider.generate({ model: "test", messages: [{ role: "user", content: "question" }] }),
    ).resolves.toEqual(expect.objectContaining({ text: "structured fake" }));
    expect(provider.requests).toHaveLength(1);
  });

  it("retries an OpenCode upstream rejection once but not other errors", async () => {
    const replies = [
      { status: 400, body: { error: { message: "Upstream request failed: Invalid request parameters." } } },
      { status: 200, body: { model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] } },
      { status: 400, body: { error: { message: "Invalid model" } } },
    ];
    const fetchImplementation = vi.fn(() => {
      const reply = replies.shift();
      if (reply === undefined) throw new Error("unexpected request");
      return Promise.resolve(new Response(JSON.stringify(reply.body), { status: reply.status, headers: { "content-type": "application/json" } }));
    });
    const environment = { CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: "opencode-go", CONCLAVE_MODEL: "m", CONCLAVE_API_KEY: "k" };
    const provider = createProvider(loadRuntimeConfig(environment), new EnvironmentCredentialSource(environment), { fetchImplementation });
    await expect(provider.generate({ model: "m", messages: [{ role: "user", content: "hi" }] })).resolves.toHaveProperty("text", "ok");
    await expect(provider.generate({ model: "m", messages: [{ role: "user", content: "hi" }] })).rejects.toThrow("Invalid model");
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
  });

  it("builds one provider per role provider only within the same vendor credential", () => {
    const environment = { CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: "opencode-go", CONCLAVE_MODEL: "m", CONCLAVE_API_KEY: "k" };
    const config = loadRuntimeConfig(environment);
    const credentials = new EnvironmentCredentialSource(environment);
    const providers = createRoleProviders(config, [{ providerId: "opencode-go" }, { providerId: "opencode-zen" }], credentials);
    expect([...providers.keys()]).toEqual(["opencode-go", "opencode-zen"]);
    expect(() => createRoleProviders(config, [{ providerId: "openrouter" }], credentials)).toThrow(/same vendor credential/);
  });

  it("sends a dedicated provider key only to that role provider", async () => {
    const seen: Record<string, string> = {};
    const fetchImplementation = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      seen[input instanceof Request ? input.url : input.toString()] = (init?.headers as Record<string, string>)["authorization"] ?? "";
      return Promise.resolve(new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), { status: 200 }));
    });
    const environment = { CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: "opencode-go", CONCLAVE_MODEL: "m", CONCLAVE_API_KEY: "go-key", CONCLAVE_OPENCODE_ZEN_API_KEY: "zen-key" };
    const providers = createRoleProviders(loadRuntimeConfig(environment), [{ providerId: "opencode-zen" }], new EnvironmentCredentialSource(environment), { fetchImplementation });
    for (const provider of providers.values()) await provider.generate({ model: "m", messages: [{ role: "user", content: "hi" }] });
    expect(seen).toEqual({
      "https://opencode.ai/zen/go/v1/chat/completions": "Bearer go-key",
      "https://opencode.ai/zen/v1/chat/completions": "Bearer zen-key",
    });
  });

  it("routes Jev on OpenCode Zen to System One and returns the judge contract", async () => {
    const requests: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImplementation = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: input instanceof Request ? input.url : input.toString(), body: JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown> });
      return Promise.resolve(new Response(JSON.stringify({
        model: "jev-1.13",
        answers: { claim_1: { type: "choice", choice: "rejected", confidence: 0.97, probabilities: { rejected: 0.98 } } },
        usage: { input_tokens: 400, output_tokens: 60 },
      }), { status: 200 }));
    });
    const environment = { CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: "opencode-zen", CONCLAVE_MODEL: "jev-1.13", CONCLAVE_API_KEY: "zen-key" };
    const provider = createProvider(loadRuntimeConfig(environment), new EnvironmentCredentialSource(environment), { fetchImplementation });
    const record = JSON.stringify({ question: "q", claims: [{ id: "claim_1", statement: "cleanup leaks the listener" }] });
    const response = await provider.generate({ model: "jev-1.13", messages: [{ role: "user", content: `BEGIN TRUSTED ADJUDICATION RECORD\n${record}\nEND TRUSTED ADJUDICATION RECORD` }] });

    expect(requests[0]?.url).toBe("https://opencode.ai/zen/v1/systemone");
    expect(requests[0]?.body).toMatchObject({ model: "jev-1.13", questions: { claim_1: { type: "choice" } } });
    expect(parseJudgeOutput(response.text, new Set(["claim_1"])).decisions).toEqual([
      expect.objectContaining({ claimId: "claim_1", status: "rejected" }),
    ]);
    expect(response.usage).toEqual({ inputTokens: 400, outputTokens: 60 });
    await expect(provider.generate({ model: "jev-1.13", messages: [{ role: "user", content: "investigate this" }] })).rejects.toThrow(/judge role/);
  });

  it("sends each OpenCode model the reasoning effort it accepts", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>);
      return Promise.resolve(
        new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    for (const model of ["deepseek-v4.1-flash", "space-bunny-free", "kimi-k2.7-code"]) {
      const environment = { CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: "opencode-go", CONCLAVE_MODEL: model, CONCLAVE_API_KEY: "k" };
      const instance = createProvider(loadRuntimeConfig(environment), new EnvironmentCredentialSource(environment), { fetchImplementation });
      await instance.generate({ model, messages: [{ role: "user", content: "hi" }] });
    }
    expect(bodies.map((body) => body["reasoning_effort"])).toEqual(["none", "low", undefined]);
  });

  it("sends a routing session header only to OpenCode Go", async () => {
    const seen: (HeadersInit | undefined)[] = [];
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      seen.push(init?.headers);
      return Promise.resolve(
        new Response(JSON.stringify({ model: "m", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    });
    for (const provider of ["opencode-go", "openai"]) {
      const environment = { CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: provider, CONCLAVE_MODEL: "m", CONCLAVE_API_KEY: "k" };
      const instance = createProvider(loadRuntimeConfig(environment), new EnvironmentCredentialSource(environment), { fetchImplementation });
      await instance.generate({ model: "m", messages: [{ role: "user", content: "hi" }] });
    }
    expect(seen[0]).toHaveProperty(["x-opencode-session"]);
    expect(seen[1]).not.toHaveProperty("x-opencode-session");
  });

  it("calls the OpenAI-compatible chat completions contract and normalizes usage", async () => {
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(
        expect.objectContaining({ authorization: "Bearer process-only-key" }),
      );
      if (typeof init?.body !== "string") {
        throw new Error("Expected a JSON string request body");
      }
      expect(JSON.parse(init.body)).toEqual(
        expect.objectContaining({
          model: "model-a",
          messages: [{ role: "user", content: "Hello" }],
          max_completion_tokens: 40,
        }),
      );
      expect(JSON.parse(init.body)).not.toHaveProperty("reasoning_effort");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            model: "model-a-2026",
            choices: [{ message: { content: "World" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 3, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    });
    const provider = new OpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "process-only-key",
      fetchImplementation,
    });

    const response = await provider.generate({
      model: "model-a",
      messages: [{ role: "user", content: "Hello" }],
      maxOutputTokens: 40,
    });

    expect(response).toEqual({
      provider: "openai",
      model: "model-a-2026",
      text: "World",
      finishReason: "stop",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      new URL("https://api.openai.test/v1/chat/completions"),
      expect.any(Object),
    );
  });

  it("routes Local Mode through the same domain-neutral provider port", async () => {
    const environment = {
      CONCLAVE_MODE: "local",
      CONCLAVE_PROVIDER: "ollama",
      CONCLAVE_MODEL: "coder",
    };
    const fetchImplementation = vi.fn((input: string | URL | Request, init?: RequestInit) => {
      void input;
      void init;
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200 }),
      );
    });
    const config = loadRuntimeConfig(environment);
    const provider = createProvider(config, new EnvironmentCredentialSource(environment), {
      fetchImplementation,
    });

    await provider.generate({
      model: "coder",
      messages: [{ role: "user", content: "ping" }],
      responseFormat: "json",
      responseSchema: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    });
    const request = fetchImplementation.mock.calls[0]?.[1];
    if (typeof request?.body !== "string") {
      throw new Error("Expected a JSON string request body");
    }
    const body: unknown = JSON.parse(request.body);
    expect(body).toMatchObject({
      reasoning_effort: "none",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "conclave_agent_output",
          strict: true,
          schema: { type: "object", additionalProperties: false },
        },
      },
    });
    expect(body).not.toHaveProperty("max_completion_tokens");
  });

  it("sends strict structured-output schemas to OpenCode Zen", async () => {
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body: unknown = JSON.parse(init.body);
      expect(body).toMatchObject({
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "conclave_agent_output",
            strict: true,
            schema: { type: "object", additionalProperties: false },
          },
        },
      });
      expect(body).not.toHaveProperty("reasoning_effort");
      return Promise.resolve(
        new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), {
          status: 200,
        }),
      );
    });
    const provider = new OpenAiCompatibleProvider({
      id: "opencode-zen",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "process-only-key",
      fetchImplementation,
    });

    await expect(
      provider.generate({
        model: "laguna-s-2.1-free",
        messages: [{ role: "user", content: "ping" }],
        responseFormat: "json",
        responseSchema: { type: "object", additionalProperties: false },
      }),
    ).resolves.toEqual(expect.objectContaining({ text: '{"ok":true}' }));
  });

  it("falls back to JSON object output when OpenCode Go rejects JSON schema", async () => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          error: { message: "This response_format type is unavailable now" },
        }), { status: 400 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
      }), { status: 200 }));
    });
    const provider = new OpenAiCompatibleProvider({
      id: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "process-only-key",
      fetchImplementation,
    });

    await expect(provider.generate({
      model: "future-model-with-unknown-schema-support",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      responseFormat: "json",
      responseSchema: { type: "object", additionalProperties: false },
    })).resolves.toEqual(expect.objectContaining({ text: '{"ok":true}' }));

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]).toMatchObject({ response_format: { type: "json_schema" } });
    expect(requestBodies[1]).toMatchObject({ response_format: { type: "json_object" } });
    expect(requestBodies[0]).not.toHaveProperty("temperature");
    expect(requestBodies[1]).not.toHaveProperty("temperature");

    await provider.generate({
      model: "future-model-with-unknown-schema-support",
      messages: [{ role: "user", content: "ping again" }],
      responseFormat: "json",
      responseSchema: { type: "object", additionalProperties: false },
    });
    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(requestBodies[2]).toMatchObject({ response_format: { type: "json_object" } });
  });

  it.each([
    "InternalError.Algo.InvalidParameter: Format error: 'response_format.json_schema.schema' rejects uniqueItems",
    'Upstream request failed: [invalid_request_error] Grammar error: Unimplemented keys: ["uniqueItems"]',
  ])("falls back when an OpenCode upstream rejects supported JSON Schema keywords: %s", async (rejection) => {
    const requestBodies: Record<string, unknown>[] = [];
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      requestBodies.push(body);
      if (requestBodies.length === 1) {
        return Promise.resolve(new Response(JSON.stringify({
          error: { message: rejection },
        }), { status: 400 }));
      }
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
      }), { status: 200 }));
    });
    const provider = new OpenAiCompatibleProvider({
      id: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "process-only-key",
      fetchImplementation,
    });

    await expect(provider.generate({
      model: "qwen3.8-max",
      messages: [{ role: "user", content: "ping" }],
      responseFormat: "json",
      responseSchema: { type: "array", uniqueItems: true },
    })).resolves.toEqual(expect.objectContaining({ text: '{"ok":true}' }));

    expect(fetchImplementation).toHaveBeenCalledTimes(2);
    expect(requestBodies[0]).toMatchObject({ response_format: { type: "json_schema" } });
    expect(requestBodies[1]).toMatchObject({ response_format: { type: "json_object" } });
  });

  it("uses JSON object output directly for DeepSeek through OpenCode", async () => {
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      expect(JSON.parse(init.body)).toMatchObject({
        model: "deepseek-v4-flash",
        response_format: { type: "json_object" },
      });
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: '{"ok":true}' } }],
      }), { status: 200 }));
    });
    const provider = new OpenAiCompatibleProvider({
      id: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "process-only-key",
      fetchImplementation,
    });

    await provider.generate({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "ping" }],
      responseFormat: "json",
      responseSchema: { type: "object", additionalProperties: false },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("retries one transient OpenCode transport failure", async () => {
    const fetchImplementation = vi.fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "recovered" } }],
      }), { status: 200 }));
    const provider = new OpenAiCompatibleProvider({
      id: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "process-only-key",
      fetchImplementation,
    });

    await expect(provider.generate({
      model: "deepseek-v4-flash",
      messages: [{ role: "user", content: "ping" }],
    })).resolves.toEqual(expect.objectContaining({ text: "recovered" }));
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("classifies transport failures by cause rather than by the runtime's error text", async () => {
    const socketFailure = new Error("something the runtime words differently");
    socketFailure.cause = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    const fetchImplementation = vi.fn()
      .mockRejectedValueOnce(socketFailure)
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "recovered" } }],
      }), { status: 200 }));
    const provider = new OpenAiCompatibleProvider({
      id: "opencode-zen",
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "process-only-key",
      fetchImplementation,
    });

    await expect(provider.generate({
      model: "kimi-k2.7-code",
      messages: [{ role: "user", content: "ping" }],
    })).resolves.toEqual(expect.objectContaining({ text: "recovered" }));
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("does not retry a request the caller already waited out", async () => {
    const fetchImplementation = vi.fn()
      .mockRejectedValue(Object.assign(new Error("The operation timed out."), { name: "TimeoutError" }));
    const provider = new OpenAiCompatibleProvider({
      id: "opencode-go",
      baseUrl: "https://opencode.ai/zen/go/v1",
      apiKey: "process-only-key",
      fetchImplementation,
    });

    await expect(provider.generate({
      model: "kimi-k2.7-code",
      messages: [{ role: "user", content: "ping" }],
    })).rejects.toThrow(ProviderError);
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("keeps a non-schema provider on json_object regardless of the requested schema", async () => {
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body["response_format"]).toEqual({ type: "json_object" });
      expect(body).not.toHaveProperty("reasoning_effort");
      expect(body["temperature"]).toBe(0);
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "{}" } }],
      }), { status: 200 }));
    });
    const provider = new OpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "process-only-key",
      fetchImplementation,
    });

    await provider.generate({
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "ping" }],
      temperature: 0,
      responseFormat: "json",
      responseSchema: { type: "object", additionalProperties: false },
    });
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("uses Anthropic's native Messages protocol and maps its response", async () => {
    const environment = {
      CONCLAVE_MODE: "api",
      CONCLAVE_PROVIDER: "anthropic",
      CONCLAVE_BASE_URL: "https://api.anthropic.test",
      CONCLAVE_API_KEY: "key",
      CONCLAVE_MODEL: "claude-sonnet-5",
    };
    const config = loadRuntimeConfig(environment);
    const fetchImplementation = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toEqual(expect.objectContaining({
        "x-api-key": "key",
        "anthropic-version": "2023-06-01",
      }));
      if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
      const body = JSON.parse(init.body) as Record<string, unknown>;
      expect(body["model"]).toBe("claude-sonnet-5");
      expect(body["max_tokens"]).toBe(40);
      expect(body["system"]).toEqual(expect.stringContaining("Return a valid JSON object only."));
      expect(body["messages"]).toEqual([{ role: "user", content: "Hello" }]);
      return Promise.resolve(new Response(JSON.stringify({
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "{\"ok\":true}" }],
        stop_reason: "end_turn",
        usage: { input_tokens: 3, output_tokens: 2 },
      }), { status: 200 }));
    });
    const provider = createProvider(config, new EnvironmentCredentialSource(environment), { fetchImplementation });

    expect(provider).toBeInstanceOf(AnthropicProvider);
    await expect(provider.generate({
      model: "claude-sonnet-5",
      messages: [{ role: "system", content: "Return structured output." }, { role: "user", content: "Hello" }],
      maxOutputTokens: 40,
      responseFormat: "json",
    })).resolves.toEqual({
      provider: "anthropic",
      model: "claude-sonnet-5",
      text: "{\"ok\":true}",
      finishReason: "end_turn",
      usage: { inputTokens: 3, outputTokens: 2 },
    });
  });

  it("uses the native Anthropic endpoint by default", () => {
    const config = loadRuntimeConfig({
      CONCLAVE_MODE: "api",
      CONCLAVE_PROVIDER: "anthropic",
      CONCLAVE_API_KEY: "key",
      CONCLAVE_MODEL: "claude-sonnet-5",
    });

    expect(config.providerSelection.baseUrl).toBe("https://api.anthropic.com");
  });

  it("avoids duplicating the version path for a custom Anthropic endpoint", async () => {
    const provider = new AnthropicProvider({
      baseUrl: "https://api.anthropic.test/v1",
      apiKey: "key",
      fetchImplementation: (input) => {
        const endpoint = input instanceof URL ? input.toString() : input instanceof Request ? input.url : input;
        expect(endpoint).toBe("https://api.anthropic.test/v1/messages");
        return Promise.resolve(new Response(JSON.stringify({
          content: [{ type: "text", text: "ok" }],
        }), { status: 200 }));
      },
    });

    await expect(provider.generate({
      model: "claude-sonnet-5",
      messages: [{ role: "user", content: "Hello" }],
    })).resolves.toEqual(expect.objectContaining({ text: "ok" }));
  });

  it("redacts a credential if an upstream error echoes it", async () => {
    const provider = new OpenAiCompatibleProvider({
      id: "openai",
      baseUrl: "https://api.openai.test/v1",
      apiKey: "do-not-leak-this-key",
      fetchImplementation: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ error: { message: "Rejected key do-not-leak-this-key" } }),
            { status: 401 },
          ),
        ),
    });

    await expect(
      provider.generate({ model: "model-a", messages: [{ role: "user", content: "Hello" }] }),
    ).rejects.toThrow("Rejected key [REDACTED]");
    expect(JSON.stringify(provider)).not.toContain("do-not-leak-this-key");
  });

  it("reports bounded Local Mode diagnostics without exposing credentials", async () => {
    const environment = { CONCLAVE_MODE: "local", CONCLAVE_PROVIDER: "ollama", CONCLAVE_MODEL: "coder" };
    const config = loadRuntimeConfig(environment);
    const diagnostics = await diagnoseProvider(config, new EnvironmentCredentialSource(environment));

    expect(diagnostics).toEqual(expect.objectContaining({ mode: "local", modelConfigured: true, retrievalLocal: true, externalCallsDisabled: true }));
    expect(JSON.stringify(diagnostics)).not.toContain("CONCLAVE_");
  });

  it("reports a safe authentication diagnosis when a provider rejects the key", async () => {
    const environment = {
      CONCLAVE_MODE: "api",
      CONCLAVE_PROVIDER: "opencode-go",
      CONCLAVE_MODEL: "kimi-k2.7-code",
      CONCLAVE_API_KEY: "do-not-return-this-key",
    };
    const config = loadRuntimeConfig(environment);
    const diagnostics = await diagnoseProvider(config, new EnvironmentCredentialSource(environment), {
      fetchImplementation: (_input, init) => {
        if (typeof init?.body !== "string") throw new Error("Expected a JSON request body");
        expect(JSON.parse(init.body)).not.toHaveProperty("temperature");
        return Promise.resolve(new Response(JSON.stringify({
          error: { message: "Invalid API key: do-not-return-this-key" },
        }), { status: 401 }));
      },
    });

    expect(diagnostics.endpointReachable).toBe(true);
    expect(diagnostics.inferenceAvailable).toBe(false);
    expect(diagnostics.statusCode).toBe(401);
    expect(diagnostics.message).toContain("rejected the API key");
    expect(JSON.stringify(diagnostics)).not.toContain("do-not-return-this-key");
  });
});
