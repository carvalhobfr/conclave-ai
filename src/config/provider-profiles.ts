import type { ReasoningPreset } from "../domain/reasoning.js";

export type GuidedProviderId = "openai" | "openrouter" | "anthropic" | "opencode-go";

export interface ProviderProfile {
  readonly id: string;
  readonly label: string;
  readonly model: string;
  readonly description: string;
}

export interface ReasoningStyle {
  readonly id: "full" | "fast";
  readonly preset: Exclude<ReasoningPreset, "local">;
  readonly label: string;
  readonly description: string;
}

const PROFILES: Readonly<Record<GuidedProviderId, readonly ProviderProfile[]>> = {
  "opencode-go": [
    { id: "baseline", label: "Essential", model: "deepseek-v4.1-flash", description: "Recommended. Best measured cost-benefit in the product lab at about $0.001 per review." },
    { id: "free", label: "Free trial", model: "space-bunny-free", description: "No cost while OpenCode offers this preview model; it may be withdrawn at any time." },
  ],
  openai: [
    { id: "balanced", label: "Balanced", model: "gpt-5.6-terra", description: "Strong code reasoning with a balance of quality and cost." },
    { id: "frontier", label: "Frontier", model: "gpt-5.6-sol", description: "Maximum reasoning quality for complex repository questions." },
    { id: "efficient", label: "Efficient", model: "gpt-5.6-luna", description: "Lower-cost option for frequent focused questions." },
    { id: "coding", label: "Coding", model: "gpt-5.3-codex", description: "Specialized coding option; verify account availability before relying on it." },
  ],
  openrouter: [
    { id: "openai-latest", label: "OpenAI latest", model: "~openai/gpt-latest", description: "Tracks OpenRouter's newest OpenAI flagship alias." },
    { id: "claude-sonnet-latest", label: "Claude Sonnet latest", model: "~anthropic/claude-sonnet-latest", description: "Tracks the current Claude Sonnet family through OpenRouter." },
    { id: "claude-opus-latest", label: "Claude Opus latest", model: "~anthropic/claude-opus-latest", description: "Tracks the current Claude Opus family through OpenRouter." },
    { id: "free", label: "Free router", model: "openrouter/free", description: "Cost-first router option; availability and quality vary." },
  ],
  anthropic: [
    { id: "balanced", label: "Balanced", model: "claude-sonnet-5", description: "High-performance default for coding and agents." },
    { id: "deep", label: "Deep work", model: "claude-opus-5", description: "For long-running and difficult coding work." },
    { id: "knowledge", label: "Knowledge work", model: "claude-fable-5", description: "For demanding knowledge and coding tasks." },
    { id: "pinned", label: "Pinned Opus", model: "claude-opus-4-8", description: "A fixed, earlier Opus model rather than a moving alias." },
  ],
};

export const REASONING_STYLES: readonly ReasoningStyle[] = [
  { id: "full", preset: "full", label: "Full Conclave", description: "Uses architecture review when the question is complex and cross-module." },
  { id: "fast", preset: "free-like", label: "Fast evidence", description: "Skips the architecture role while retaining investigator, verification, and judge stages." },
];

export function isGuidedProviderId(value: string): value is GuidedProviderId {
  return value === "openai" || value === "openrouter" || value === "anthropic" || value === "opencode-go";
}

export function providerProfiles(provider: GuidedProviderId): readonly ProviderProfile[] {
  return PROFILES[provider];
}

export function providerProfile(
  provider: GuidedProviderId,
  profileId: string | undefined,
): ProviderProfile {
  const profiles = providerProfiles(provider);
  const selected = profileId === undefined
    ? profiles[0]
    : profiles.find((profile) => profile.id === profileId);
  if (selected === undefined) {
    throw new Error(
      `Unknown ${provider} profile: ${profileId ?? ""}. Available: ${profiles.map((profile) => profile.id).join(", ")}`,
    );
  }
  return selected;
}

export function reasoningStyle(id: string | undefined): ReasoningStyle {
  const selected = id === undefined
    ? REASONING_STYLES[0]
    : REASONING_STYLES.find((style) => style.id === id);
  if (selected === undefined) {
    throw new Error(`Unknown reasoning style: ${id ?? ""}. Available: ${REASONING_STYLES.map((style) => style.id).join(", ")}`);
  }
  return selected;
}
