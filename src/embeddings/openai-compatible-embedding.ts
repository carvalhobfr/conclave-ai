import type { EmbeddingProvider, EmbeddingRequest, EmbeddingResult } from "../domain/embedding.js";
import { EXCLUDED_CONTEXT_MARKER, redactSecrets } from "../security/model-context.js";
import { ProviderError } from "../domain/provider.js";
import type { FetchLike } from "../providers/openai-compatible-provider.js";

export interface OpenAiCompatibleEmbeddingProviderOptions {
  readonly id: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly dimensions: number;
  readonly apiKey?: string;
  readonly allowInsecureHttp?: boolean;
  readonly fetchImplementation?: FetchLike;
  readonly timeoutMs?: number;
}

function redact(value: string, secret: string | undefined): string {
  return secret === undefined || secret === "" ? value : value.replaceAll(secret, "[REDACTED]");
}

function vectors(payload: unknown, expected: number, provider: string): readonly number[][] {
  if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new ProviderError("Embedding provider returned an invalid response", provider as never);
  }
  const data = (payload as { readonly data: readonly unknown[] }).data;
  if (data.length !== expected) throw new ProviderError("Embedding provider returned an incomplete batch", provider as never);
  return data.map((item) => {
    const embedding = typeof item === "object" && item !== null ? (item as { embedding?: unknown }).embedding : undefined;
    if (!Array.isArray(embedding) || !embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
      throw new ProviderError("Embedding provider returned an invalid vector", provider as never);
    }
    return embedding as number[];
  });
}

/** Embedding input leaves the machine like any model request, so it crosses the same boundary. */
function outgoingText(text: string): string {
  const result = redactSecrets(text);
  return result.residual ? EXCLUDED_CONTEXT_MARKER : result.text;
}

/** A small OpenAI-compatible embeddings adapter. It is opt-in and never substitutes feature hashing. */
export class OpenAiCompatibleEmbeddingProvider implements EmbeddingProvider {
  public readonly kind = "learned-semantic" as const;
  public readonly id: string;
  public readonly dimensions: number;
  readonly #model: string;
  readonly #endpoint: URL;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  public constructor(options: OpenAiCompatibleEmbeddingProviderOptions) {
    const baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (baseUrl.username !== "" || baseUrl.password !== "" || baseUrl.search !== "" || baseUrl.hash !== "") {
      throw new ProviderError("Embedding provider URL must not contain credentials, query parameters, or fragments", "openai-compatible");
    }
    if (baseUrl.protocol !== "https:" && options.allowInsecureHttp !== true) {
      throw new ProviderError("External embedding provider URL must use HTTPS", "openai-compatible");
    }
    if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
      throw new ProviderError("Embedding provider URL must use HTTP or HTTPS", "openai-compatible");
    }
    if (!Number.isInteger(options.dimensions) || options.dimensions <= 0 || options.dimensions > 16_384) {
      throw new ProviderError("Embedding dimensions must be a positive bounded integer", "openai-compatible");
    }
    this.#model = options.model;
    this.#endpoint = new URL("embeddings", baseUrl);
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
    this.dimensions = options.dimensions;
    this.id = options.id;
  }

  public async embed(requests: readonly EmbeddingRequest[]): Promise<readonly EmbeddingResult[]> {
    if (requests.length === 0) return [];
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", ...(this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` }) },
        body: JSON.stringify({ model: this.#model, input: requests.map((request) => outgoingText(request.text)) }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(`Embedding request failed: ${redact(error instanceof Error ? error.message : "unknown network error", this.#apiKey)}`, "openai-compatible");
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new ProviderError("Embedding provider returned a non-JSON response", "openai-compatible", response.status); }
    if (!response.ok) {
      const message = typeof payload === "object" && payload !== null && typeof (payload as { error?: { message?: unknown } }).error?.message === "string" ? (payload as { error: { message: string } }).error.message : `Embedding request failed with status ${String(response.status)}`;
      throw new ProviderError(redact(message, this.#apiKey), "openai-compatible", response.status);
    }
    return vectors(payload, requests.length, "openai-compatible").map((vector, index) => {
      if (vector.length !== this.dimensions) throw new ProviderError(`Embedding dimensions differ from configured ${String(this.dimensions)}`, "openai-compatible");
      const request = requests[index];
      if (request === undefined) throw new ProviderError("Embedding response ordering was invalid", "openai-compatible");
      return { identity: request.identity, vector };
    });
  }
}
