import type { GenerateRequest, GenerateResponse, LlmProvider, ProviderId } from "../domain/provider.js";
import { ProviderError } from "../domain/provider.js";
import type { FetchLike } from "./openai-compatible-provider.js";

const RECORD_START = "BEGIN TRUSTED ADJUDICATION RECORD";
const RECORD_END = "END TRUSTED ADJUDICATION RECORD";
const STATUSES = ["supported", "rejected", "uncertain"] as const;

export interface SystemOneJudgeProviderOptions {
  readonly id: ProviderId;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly fetchImplementation?: FetchLike;
  readonly timeoutMs?: number;
}

interface AdjudicationClaim {
  readonly id: string;
  readonly statement: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function adjudicationRecord(request: GenerateRequest): { readonly state: string; readonly claims: readonly AdjudicationClaim[] } {
  const prompt = request.messages.map((message) => message.content).join("\n");
  const start = prompt.indexOf(RECORD_START);
  const end = prompt.indexOf(RECORD_END, start);
  if (start === -1 || end === -1) {
    throw new ProviderError("System One models only serve the judge role (no adjudication record in the request)", "opencode-zen");
  }
  const state = prompt.slice(start + RECORD_START.length, end).trim();
  const parsed: unknown = JSON.parse(state);
  const claims = isRecord(parsed) && Array.isArray(parsed["claims"])
    ? parsed["claims"].flatMap((claim) =>
      isRecord(claim) && typeof claim["id"] === "string" && typeof claim["statement"] === "string"
        ? [{ id: claim["id"], statement: claim["statement"] }]
        : [])
    : [];
  return { state, claims };
}

/**
 * Serves the judge role with a System One decision model (e.g. Jev on OpenCode Zen). Instead of
 * generating text, it asks one typed choice question per claim and returns the judge's JSON contract.
 */
export class SystemOneJudgeProvider implements LlmProvider {
  public readonly id: ProviderId;
  readonly #endpoint: URL;
  readonly #apiKey: string | undefined;
  readonly #fetch: FetchLike;
  readonly #timeoutMs: number;

  public constructor(options: SystemOneJudgeProviderOptions) {
    const baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (baseUrl.protocol !== "https:") throw new ProviderError("External provider URL must use HTTPS", options.id);
    this.id = options.id;
    this.#endpoint = new URL("systemone", baseUrl);
    this.#apiKey = options.apiKey;
    this.#fetch = options.fetchImplementation ?? fetch;
    this.#timeoutMs = options.timeoutMs ?? 60_000;
  }

  public async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const { state, claims } = adjudicationRecord(request);
    if (claims.length === 0) {
      return { provider: this.id, model: request.model, text: JSON.stringify({ decisions: [] }) };
    }
    const questions = Object.fromEntries(claims.map((claim) => [claim.id, {
      type: "choice",
      instructions: `Given the adjudication record, what is the final status of claim ${claim.id}: "${claim.statement}"?`,
      criteria: {
        supported: "The cited evidence and verification establish the claim",
        rejected: "The evidence or verification contradicts the claim",
        uncertain: "The record does not establish the claim either way",
      },
    }]));
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(this.#apiKey === undefined ? {} : { authorization: `Bearer ${this.#apiKey}` }),
        },
        body: JSON.stringify({ model: request.model, state, questions }),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (error) {
      throw new ProviderError(`Provider request failed: ${error instanceof Error ? error.message : "unknown network error"}`, this.id);
    }
    const payload: unknown = await response.json().catch(() => undefined);
    if (!response.ok || !isRecord(payload) || !isRecord(payload["answers"])) {
      const message = isRecord(payload) && isRecord(payload["error"]) && typeof payload["error"]["message"] === "string"
        ? payload["error"]["message"]
        : `System One request failed with status ${String(response.status)}`;
      throw new ProviderError(message.slice(0, 500), this.id, response.status);
    }
    const answers = payload["answers"];
    const decisions = claims.flatMap((claim) => {
      const answer = answers[claim.id];
      if (!isRecord(answer) || !STATUSES.includes(answer["choice"] as (typeof STATUSES)[number])) return [];
      const confidence = typeof answer["confidence"] === "number" ? answer["confidence"].toFixed(2) : "unknown";
      return [{ claimId: claim.id, status: answer["choice"], explanation: `${request.model} decided ${String(answer["choice"])} with confidence ${confidence}.` }];
    });
    const usage = isRecord(payload["usage"]) ? payload["usage"] : {};
    return {
      provider: this.id,
      model: typeof payload["model"] === "string" ? payload["model"] : request.model,
      text: JSON.stringify({ decisions }),
      usage: {
        ...(typeof usage["input_tokens"] === "number" ? { inputTokens: usage["input_tokens"] } : {}),
        ...(typeof usage["output_tokens"] === "number" ? { outputTokens: usage["output_tokens"] } : {}),
      },
    };
  }
}
