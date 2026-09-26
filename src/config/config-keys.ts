/** Short, memorable names for the CONCLAVE_* settings people edit most often. */
export const CONFIG_KEY_ALIASES: Readonly<Record<string, string>> = {
  provider: "CONCLAVE_PROVIDER",
  model: "CONCLAVE_MODEL",
  "api-key": "CONCLAVE_API_KEY",
  key: "CONCLAVE_API_KEY",
  "base-url": "CONCLAVE_BASE_URL",
  endpoint: "CONCLAVE_BASE_URL",
  reasoning: "CONCLAVE_REASONING_PRESET",
  mode: "CONCLAVE_MODE",
  "fallback-model": "CONCLAVE_FALLBACK_MODEL",
  "embedding-mode": "CONCLAVE_EMBEDDING_MODE",
  "embedding-model": "CONCLAVE_EMBEDDING_MODEL",
  "embedding-api-key": "CONCLAVE_EMBEDDING_API_KEY",
};

/** Keys shown by `conclave config` even when unset, in display order. */
export const PRIMARY_CONFIG_KEYS = [
  "CONCLAVE_MODE",
  "CONCLAVE_PROVIDER",
  "CONCLAVE_MODEL",
  "CONCLAVE_API_KEY",
  "CONCLAVE_BASE_URL",
  "CONCLAVE_REASONING_PRESET",
] as const;

const VALID_VALUES: Readonly<Record<string, readonly string[]>> = {
  CONCLAVE_MODE: ["api", "local", "free"],
  CONCLAVE_REASONING_PRESET: ["full", "free-like", "local"],
  CONCLAVE_PROVIDER: ["openai", "openrouter", "anthropic", "opencode-go", "opencode-zen", "ollama", "lm-studio", "openai-compatible"],
};

export function resolveConfigKey(name: string): string {
  const trimmed = name.trim();
  const alias = CONFIG_KEY_ALIASES[trimmed.toLowerCase()];
  if (alias !== undefined) return alias;
  const upper = trimmed.toUpperCase().replaceAll("-", "_");
  const key = upper.startsWith("CONCLAVE_") ? upper : `CONCLAVE_${upper}`;
  if (!/^CONCLAVE_[A-Z0-9_]+$/u.test(key)) throw new Error(`Invalid setting name: ${name}`);
  return key;
}

export function isSecretKey(key: string): boolean {
  return key.endsWith("_API_KEY") || key.endsWith("_TOKEN") || key.endsWith("_SECRET");
}

/** Never prints a secret; the tail is enough to tell two keys apart. */
export function maskValue(key: string, value: string): string {
  if (!isSecretKey(key)) return value;
  if (value.length <= 12) return "•".repeat(8);
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

export function validateConfigValue(key: string, value: string): string {
  const trimmed = value.trim();
  if (trimmed.includes("\n") || trimmed.includes("\r") || trimmed.includes("\u0000")) {
    throw new Error(`${key} must be a single line`);
  }
  const allowed = VALID_VALUES[key];
  if (allowed !== undefined && !allowed.includes(trimmed)) {
    throw new Error(`${key} must be one of: ${allowed.join(", ")}`);
  }
  return trimmed;
}
