import type {
  GenerateRequest,
  GenerateResponse,
  LlmProvider,
  ProviderMessage,
  TokenUsage,
} from "../domain/provider.js";
import { ProviderError } from "../domain/provider.js";
import { runCliProcess } from "./cli-process.js";

export interface ClaudeCliProviderOptions {
  /** Executable name or absolute path; defaults to `claude` on PATH. */
  readonly command?: string | undefined;
  readonly timeoutMs?: number;
}

interface ClaudeCliResult {
  readonly type?: string;
  readonly subtype?: string;
  readonly is_error?: boolean;
  readonly result?: string;
  readonly structured_output?: unknown;
  readonly usage?: {
    readonly input_tokens?: number;
    readonly output_tokens?: number;
    readonly cache_creation_input_tokens?: number;
    readonly cache_read_input_tokens?: number;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseResult(stdout: string): ClaudeCliResult {
  let payload: unknown;
  try {
    payload = JSON.parse(stdout);
  } catch {
    throw new ProviderError("Claude CLI returned non-JSON output", "claude-cli");
  }
  if (!isRecord(payload) || payload["type"] !== "result") {
    throw new ProviderError("Claude CLI returned an unexpected payload", "claude-cli");
  }
  return payload;
}

function usageOf(result: ClaudeCliResult): TokenUsage | undefined {
  const usage = result.usage;
  if (usage === undefined) return undefined;
  // Cached prompt tokens are still input the model read; count them so totals stay honest.
  const inputTokens =
    (usage.input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0);
  return {
    inputTokens,
    ...(usage.output_tokens === undefined ? {} : { outputTokens: usage.output_tokens }),
  };
}

/**
 * Flattens the conversation into one prompt. The system text goes to `--system-prompt`; earlier
 * assistant or user turns are labelled so the model can still tell who said what.
 */
function userPrompt(messages: readonly ProviderMessage[]): string {
  const turns = messages.filter((message) => message.role !== "system");
  if (turns.length === 1) return turns[0]?.content ?? "";
  return turns.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");
}

/**
 * Runs the locally installed `claude` CLI in print mode, so requests use the user's Claude
 * subscription login instead of an API key. Tools are disabled: the CLI is used as a plain text
 * model. Sampling temperature and output-token limits are not exposed by the CLI and are ignored.
 */
export class ClaudeCliProvider implements LlmProvider {
  public readonly id = "claude-cli" as const;
  readonly #command: string;
  readonly #timeoutMs: number;

  public constructor(options: ClaudeCliProviderOptions = {}) {
    this.#command = options.command ?? "claude";
    this.#timeoutMs = options.timeoutMs ?? 180_000;
  }

  public async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const system = request.messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n");
    const args = [
      "--print",
      "--output-format", "json",
      "--model", request.model,
      "--tools", "",
      "--no-session-persistence",
      // Only the flag's empty value skips user, project and local settings: no hooks, no CLAUDE.md.
      // Subscription login still works because it lives outside the settings files.
      "--setting-sources", "",
      "--system-prompt", system === "" ? "You are a helpful assistant." : system,
    ];
    if (request.responseSchema !== undefined) {
      args.push("--json-schema", JSON.stringify(request.responseSchema));
    }
    const prompt = userPrompt(request.messages);
    const stdout = await runCliProcess({
      provider: this.id,
      label: "Claude CLI",
      command: this.#command,
      args,
      stdin: request.responseFormat === "json" && request.responseSchema === undefined
        ? `${prompt}\n\nReturn a valid JSON object only.`
        : prompt,
      timeoutMs: this.#timeoutMs,
      // An API key in the environment would make the CLI bill the API instead of the subscription.
      withoutEnvironment: ["ANTHROPIC_API_KEY"],
    });
    const result = parseResult(stdout);
    if (result.is_error === true || result.subtype !== "success") {
      throw new ProviderError(
        `Claude CLI failed: ${(result.result ?? result.subtype ?? "unknown error").slice(0, 500)}`,
        "claude-cli",
      );
    }
    const text =
      result.structured_output !== undefined
        ? JSON.stringify(result.structured_output)
        : (result.result ?? "");
    if (text.trim() === "") throw new ProviderError("Claude CLI returned an empty answer", "claude-cli");
    const usage = usageOf(result);
    return {
      provider: this.id,
      model: request.model,
      text,
      finishReason: "end_turn",
      ...(usage === undefined ? {} : { usage }),
    };
  }
}
