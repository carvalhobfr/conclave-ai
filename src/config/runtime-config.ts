import type {
  ApiModeConfig,
  FreeModeConfig,
  LocalModeConfig,
  PublicRuntimeConfig,
  RuntimeConfig,
} from "../domain/execution-mode.js";
import type { CredentialSource } from "../domain/storage.js";
import type { ProviderId } from "../domain/provider.js";

const PROVIDER_IDS = new Set<ProviderId>([
  "openai",
  "openrouter",
  "anthropic",
  "gemini",
  "opencode-go",
  "opencode-zen",
  "ollama",
  "lm-studio",
  "openai-compatible",
]);

const LOCAL_PROVIDERS = new Set<ProviderId>(["ollama", "lm-studio", "openai-compatible"]);

export class ConfigurationError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

function parseProvider(value: string | undefined, fallback: ProviderId): Exclude<ProviderId, "fake"> {
  const provider = value ?? fallback;
  if (!PROVIDER_IDS.has(provider as ProviderId) || provider === "fake") {
    throw new ConfigurationError(`Unsupported provider identifier: ${provider}`);
  }
  return provider as Exclude<ProviderId, "fake">;
}

function optionalNonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === "" ? undefined : trimmed;
}

function validateBaseUrl(baseUrl: string, mode: RuntimeConfig["mode"]): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new ConfigurationError("Provider base URL is invalid");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ConfigurationError("Provider base URL must not contain credentials");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new ConfigurationError("Provider base URL must not contain query parameters or fragments");
  }
  if (mode === "local") {
    const loopbackHosts = new Set(["127.0.0.1", "[::1]", "localhost"]);
    if (!loopbackHosts.has(parsed.hostname)) {
      throw new ConfigurationError("Local Mode provider URL must use a loopback host");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new ConfigurationError("Local Mode provider URL must use HTTP or HTTPS");
    }
  } else if (parsed.protocol !== "https:") {
    throw new ConfigurationError("External provider URLs must use HTTPS");
  }
  return parsed.toString().replace(/\/$/, "");
}

export function defaultBaseUrl(provider: Exclude<ProviderId, "fake">): string | undefined {
  switch (provider) {
    case "openai":
      return "https://api.openai.com/v1";
    case "openrouter":
      return "https://openrouter.ai/api/v1";
    case "ollama":
      return "http://127.0.0.1:11434/v1";
    case "lm-studio":
      return "http://127.0.0.1:1234/v1";
    case "anthropic":
      return "https://api.anthropic.com";
    case "gemini":
    case "openai-compatible":
      return undefined;
    case "opencode-go":
      return "https://opencode.ai/zen/go/v1";
    case "opencode-zen":
      return "https://opencode.ai/zen/v1";
  }
}

function providerSelection(
  provider: Exclude<ProviderId, "fake">,
  model: string | undefined,
  requestedBaseUrl: string | undefined,
  mode: RuntimeConfig["mode"],
): RuntimeConfig["providerSelection"] {
  const unresolvedBaseUrl = optionalNonEmpty(requestedBaseUrl) ?? defaultBaseUrl(provider);
  const baseUrl = unresolvedBaseUrl === undefined ? undefined : validateBaseUrl(unresolvedBaseUrl, mode);
  return {
    provider,
    ...(model === undefined ? {} : { model }),
    ...(baseUrl === undefined ? {} : { baseUrl }),
  };
}

export function loadRuntimeConfig(environment: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const mode = optionalNonEmpty(environment["CONCLAVE_MODE"]) ?? "free";

  if (mode === "free") {
    const provider = parseProvider(environment["CONCLAVE_FREE_PROVIDER"], "openai");
    if (LOCAL_PROVIDERS.has(provider)) {
      throw new ConfigurationError("Free Mode requires an externally hosted provider");
    }
    const config: FreeModeConfig = {
      mode,
      privacyBoundary: "external",
      credentialEnvironmentVariable: "CONCLAVE_FREE_API_KEY",
      providerSelection: providerSelection(
        provider,
        optionalNonEmpty(environment["CONCLAVE_FREE_MODEL"]),
        environment["CONCLAVE_FREE_BASE_URL"],
        mode,
      ),
    };
    return config;
  }

  if (mode === "api") {
    const provider = parseProvider(environment["CONCLAVE_PROVIDER"], "openai");
    const config: ApiModeConfig = {
      mode,
      privacyBoundary: "external",
      credentialEnvironmentVariable: "CONCLAVE_API_KEY",
      providerSelection: providerSelection(
        provider,
        optionalNonEmpty(environment["CONCLAVE_MODEL"]),
        environment["CONCLAVE_BASE_URL"],
        mode,
      ),
    };
    return config;
  }

  if (mode === "local") {
    const provider = parseProvider(environment["CONCLAVE_PROVIDER"], "ollama");
    if (!LOCAL_PROVIDERS.has(provider)) {
      throw new ConfigurationError("Local Mode requires Ollama, LM Studio, or an OpenAI-compatible local provider");
    }
    const config: LocalModeConfig = {
      mode,
      privacyBoundary: "local-only",
      providerSelection: providerSelection(
        provider,
        optionalNonEmpty(environment["CONCLAVE_MODEL"]),
        environment["CONCLAVE_BASE_URL"],
        mode,
      ),
    };
    return config;
  }

  throw new ConfigurationError(`Unknown Conclave mode: ${mode}`);
}

export function describeRuntimeConfig(
  config: RuntimeConfig,
  credentials: CredentialSource,
): PublicRuntimeConfig {
  const credentialReference =
    config.mode === "local" ? undefined : config.credentialEnvironmentVariable;
  return {
    mode: config.mode,
    privacyBoundary: config.privacyBoundary,
    provider: config.providerSelection.provider,
    modelConfigured: config.providerSelection.model !== undefined,
    ...(config.providerSelection.baseUrl === undefined
      ? {}
      : { baseUrl: config.providerSelection.baseUrl }),
    credentialSource:
      config.mode === "free"
        ? "server-environment"
        : config.mode === "api"
          ? "user-environment"
          : "not-required",
    credentialConfigured:
      credentialReference === undefined ? false : credentials.get(credentialReference) !== undefined,
  };
}
