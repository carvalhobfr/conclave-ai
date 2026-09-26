import { randomUUID } from "node:crypto";
import type { RuntimeConfig } from "../domain/execution-mode.js";
import type { CredentialSource } from "../domain/storage.js";
import type { LlmProvider, ProviderId } from "../domain/provider.js";
import { ConfigurationError, defaultBaseUrl } from "../config/runtime-config.js";
import { AnthropicProvider } from "./anthropic-provider.js";
import { OpenAiCompatibleProvider, type FetchLike } from "./openai-compatible-provider.js";
import { SystemOneJudgeProvider } from "./systemone-judge-provider.js";

export interface ProviderFactoryOptions {
  readonly fetchImplementation?: FetchLike;
}

export function createProvider(
  config: RuntimeConfig,
  credentials: CredentialSource,
  options: ProviderFactoryOptions = {},
): LlmProvider {
  const selection = config.providerSelection;
  if (selection.provider === "gemini") {
    throw new ConfigurationError(
      `${selection.provider} uses a provider-specific protocol; its adapter is not implemented in Phase 1`,
    );
  }
  if (selection.baseUrl === undefined) {
    throw new ConfigurationError(`CONCLAVE_BASE_URL is required for provider ${selection.provider}`);
  }

  const apiKey =
    config.mode === "local"
      ? undefined
      : credentials.get(config.credentialEnvironmentVariable);
  if (config.mode !== "local" && apiKey === undefined) {
    throw new ConfigurationError(
      `${config.credentialEnvironmentVariable} is required for ${config.mode} mode`,
    );
  }

  if (selection.provider === "anthropic") {
    if (apiKey === undefined) {
      throw new ConfigurationError("An API credential is required for Anthropic");
    }
    return new AnthropicProvider({
      baseUrl: selection.baseUrl,
      apiKey,
      ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
    });
  }

  const chat = new OpenAiCompatibleProvider({
    id: selection.provider,
    baseUrl: selection.baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(options.fetchImplementation === undefined
      ? {}
      : { fetchImplementation: options.fetchImplementation }),
    allowInsecureHttp: config.mode === "local",
    ...(selection.provider === "opencode-go" ? { extraHeaders: { "x-opencode-session": randomUUID() } } : {}),
    ...(config.mode === "local" || selection.provider === "opencode-go" || selection.provider === "opencode-zen"
      ? { timeoutMs: 180_000 }
      : {}),
    maxTokensField: config.mode === "local" ? "max_tokens" : "max_completion_tokens",
  });
  if (selection.provider !== "opencode-zen") return chat;
  // OpenCode Zen serves System One decision models (Jev) on a separate endpoint; route them by model name.
  const systemOne = new SystemOneJudgeProvider({
    id: selection.provider,
    baseUrl: selection.baseUrl,
    ...(apiKey === undefined ? {} : { apiKey }),
    ...(options.fetchImplementation === undefined ? {} : { fetchImplementation: options.fetchImplementation }),
  });
  return { id: chat.id, generate: (request) => (request.model.startsWith("jev-") ? systemOne : chat).generate(request) };
}

// Providers billed to one vendor account: the same credential may be sent to each of them.
const SHARED_CREDENTIAL_FAMILIES: readonly (readonly ProviderId[])[] = [["opencode-go", "opencode-zen"]];

/** One provider per distinct role provider; roles may only span providers of the same vendor. */
export function createRoleProviders(
  config: RuntimeConfig,
  assignments: readonly { readonly providerId: string }[],
  credentials: CredentialSource,
  options: ProviderFactoryOptions = {},
): ReadonlyMap<string, LlmProvider> {
  const primary = createProvider(config, credentials, options);
  const providers = new Map<string, LlmProvider>([[primary.id, primary]]);
  const family = SHARED_CREDENTIAL_FAMILIES.find((members) => members.includes(config.providerSelection.provider));
  for (const providerId of new Set(assignments.map((assignment) => assignment.providerId))) {
    if (providers.has(providerId)) continue;
    // A dedicated key (e.g. CONCLAVE_OPENCODE_ZEN_API_KEY) is sent only to its own provider; without one,
    // the main key may be reused only by providers of the same vendor.
    const dedicatedVariable = `CONCLAVE_${providerId.toUpperCase().replaceAll("-", "_")}_API_KEY`;
    const dedicatedKey = credentials.get(dedicatedVariable);
    if (dedicatedKey === undefined && family?.includes(providerId as ProviderId) !== true) {
      throw new ConfigurationError(
        `A reasoning role uses ${providerId} while CONCLAVE_PROVIDER is ${config.providerSelection.provider}; ` +
        `set ${dedicatedVariable}, since roles may only share the same vendor credential.`,
      );
    }
    const roleCredentials: CredentialSource = dedicatedKey === undefined || config.mode === "local"
      ? credentials
      : { get: (reference) => (reference === config.credentialEnvironmentVariable ? dedicatedKey : credentials.get(reference)) };
    const provider = providerId as Exclude<ProviderId, "fake">;
    const baseUrl = defaultBaseUrl(provider);
    providers.set(providerId, createProvider(
      { ...config, providerSelection: { provider, ...(baseUrl === undefined ? {} : { baseUrl }) } },
      roleCredentials,
      options,
    ));
  }
  return providers;
}
