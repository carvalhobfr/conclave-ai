import type { ProviderId } from "../domain/provider.js";

/**
 * Transport-level quirks of each OpenAI-compatible endpoint, kept in one table instead of
 * scattered checks inside the request builder. Adding a provider means adding a row here.
 */
export type ReasoningEffort = "none" | "low";

export interface ProviderCapabilities {
  /** Endpoints that reject `temperature` outright rather than clamping it. */
  readonly acceptsTemperature: boolean;
  /** Endpoints that understand `response_format: { type: "json_schema" }`. */
  readonly acceptsJsonSchema: boolean;
  /**
   * Model-name prefixes that advertise JSON-schema support but return malformed or empty
   * output for it. These fall back to `json_object` without paying for a rejected request.
   */
  readonly jsonObjectOnlyModelPrefixes: readonly string[];
  /** Endpoints that default to a reasoning pass Conclave does not want to pay for. */
  readonly disablesReasoningEffort: boolean;
  /**
   * Reasoning effort per model-name prefix, first match wins. Unbounded reasoning can consume the
   * whole output budget and leave an empty answer; some models reject "none" but accept "low".
   */
  readonly reasoningEffortByModelPrefix: readonly (readonly [prefix: string, effort: ReasoningEffort])[];
  /** Endpoints observed to drop the first connection of a session. */
  readonly retriesNetworkFailure: boolean;
  /** Gateways whose upstream intermittently rejects valid requests (e.g. during peak hours). */
  readonly retriesUpstreamFailure: boolean;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  acceptsTemperature: true,
  acceptsJsonSchema: false,
  jsonObjectOnlyModelPrefixes: [],
  disablesReasoningEffort: false,
  reasoningEffortByModelPrefix: [],
  retriesNetworkFailure: false,
  retriesUpstreamFailure: false,
};

const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  acceptsTemperature: false,
  acceptsJsonSchema: true,
  jsonObjectOnlyModelPrefixes: ["deepseek-"],
  disablesReasoningEffort: false,
  // Probed on OpenCode Go (2026-09-25): each accepts the listed effort and returns valid JSON.
  reasoningEffortByModelPrefix: [
    ["glm-5.3-flash", "low"],
    ["space-bunny", "low"],
    ["deepseek-", "none"],
    ["mimo-", "none"],
    ["qwen3.", "none"],
    ["hy3", "none"],
  ],
  retriesNetworkFailure: true,
  retriesUpstreamFailure: true,
};

const CAPABILITIES: Partial<Readonly<Record<ProviderId, ProviderCapabilities>>> = {
  ollama: {
    ...DEFAULT_CAPABILITIES,
    acceptsJsonSchema: true,
    disablesReasoningEffort: true,
  },
  "opencode-go": OPENCODE_CAPABILITIES,
  "opencode-zen": OPENCODE_CAPABILITIES,
};

export function providerCapabilities(provider: ProviderId): ProviderCapabilities {
  return CAPABILITIES[provider] ?? DEFAULT_CAPABILITIES;
}

export function reasoningEffort(capabilities: ProviderCapabilities, model: string): ReasoningEffort | undefined {
  if (capabilities.disablesReasoningEffort) return "none";
  return capabilities.reasoningEffortByModelPrefix.find(([prefix]) => model.startsWith(prefix))?.[1];
}

export function prefersJsonObject(capabilities: ProviderCapabilities, model: string): boolean {
  return capabilities.jsonObjectOnlyModelPrefixes.some((prefix) => model.startsWith(prefix));
}

const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_SOCKET",
  "UND_ERR_CONNECT_TIMEOUT",
]);

/**
 * Classifies a transport failure by its cause rather than by the runtime's error text, which
 * differs between Node releases and between Node, Bun, and Deno. A timeout raised by
 * `AbortSignal.timeout` is deliberately excluded: the caller already waited the full budget.
 */
export function isRetriableNetworkError(error: unknown): boolean {
  if (!(error instanceof Error) || error.name === "TimeoutError" || error.name === "AbortError") {
    return false;
  }
  const cause: unknown = error.cause;
  if (isErrorWithCode(cause) && NETWORK_ERROR_CODES.has(cause.code)) return true;
  if (isErrorWithCode(error) && NETWORK_ERROR_CODES.has(error.code)) return true;
  // undici surfaces a bare `TypeError: fetch failed` and hides the real reason in `cause`.
  return error instanceof TypeError;
}

function isErrorWithCode(value: unknown): value is { readonly code: string } {
  return typeof value === "object"
    && value !== null
    && "code" in value
    && typeof (value as { readonly code: unknown }).code === "string";
}
