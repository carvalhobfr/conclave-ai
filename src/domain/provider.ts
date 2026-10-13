export type ProviderId =
  | "openai"
  | "openrouter"
  | "anthropic"
  | "gemini"
  | "opencode-go"
  | "opencode-zen"
  | "claude-cli"
  | "codex-cli"
  | "ollama"
  | "lm-studio"
  | "openai-compatible"
  | "fake";

export type ProviderMessageRole = "system" | "user" | "assistant";

export interface ProviderMessage {
  readonly role: ProviderMessageRole;
  readonly content: string;
}

export interface GenerateRequest {
  readonly model: string;
  readonly messages: readonly ProviderMessage[];
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly responseFormat?: "text" | "json";
  readonly responseSchema?: Readonly<Record<string, unknown>>;
}

export interface TokenUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

export interface GenerateResponse {
  readonly provider: ProviderId;
  readonly model: string;
  readonly text: string;
  readonly finishReason?: string;
  readonly usage?: TokenUsage;
}

export interface LlmProvider {
  readonly id: ProviderId;
  generate(request: GenerateRequest): Promise<GenerateResponse>;
}

export class ProviderError extends Error {
  public readonly provider: ProviderId;
  public readonly statusCode: number | undefined;

  public constructor(message: string, provider: ProviderId, statusCode?: number) {
    super(message);
    this.name = "ProviderError";
    this.provider = provider;
    this.statusCode = statusCode;
  }
}
