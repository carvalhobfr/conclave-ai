import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GenerateRequest, GenerateResponse, LlmProvider, ProviderMessage } from "../domain/provider.js";
import { ProviderError } from "../domain/provider.js";
import { runCliProcess } from "./cli-process.js";

export interface CodexCliProviderOptions {
  /** Executable name or absolute path; defaults to `codex` on PATH. */
  readonly command?: string | undefined;
  readonly timeoutMs?: number;
}

/**
 * `codex exec` has no system-prompt flag, so system text is placed ahead of the user turns in the
 * single prompt. Turns are labelled the same way the Claude adapter labels them.
 */
function combinedPrompt(messages: readonly ProviderMessage[]): string {
  const system = messages.filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
  const turns = messages.filter((message) => message.role !== "system");
  const body = turns.length === 1 ? (turns[0]?.content ?? "") : turns.map((message) => `[${message.role}]\n${message.content}`).join("\n\n");
  return system === "" ? body : `${system}\n\n${body}`;
}

/**
 * Runs the locally installed `codex` CLI non-interactively, so requests use the user's ChatGPT
 * subscription login (`codex login`) instead of an OpenAI API key. The sandbox is read-only and
 * user configuration, plugins and rules are ignored, so the CLI behaves as a plain text model.
 * Sampling temperature and output-token limits are not exposed by the CLI and are ignored.
 */
export class CodexCliProvider implements LlmProvider {
  public readonly id = "codex-cli" as const;
  readonly #command: string;
  readonly #timeoutMs: number;

  public constructor(options: CodexCliProviderOptions = {}) {
    this.#command = options.command ?? "codex";
    this.#timeoutMs = options.timeoutMs ?? 180_000;
  }

  public async generate(request: GenerateRequest): Promise<GenerateResponse> {
    const scratch = await mkdtemp(join(tmpdir(), "conclave-codex-"));
    try {
      const outputFile = join(scratch, "answer.txt");
      const args = [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--skip-git-repo-check",
        "--sandbox", "read-only",
        "--cd", scratch,
        "--model", request.model,
        "--output-last-message", outputFile,
      ];
      if (request.responseSchema !== undefined) {
        const schemaFile = join(scratch, "schema.json");
        await writeFile(schemaFile, JSON.stringify(request.responseSchema));
        args.push("--output-schema", schemaFile);
      }
      args.push("-");
      const prompt = combinedPrompt(request.messages);
      await runCliProcess({
        provider: this.id,
        label: "Codex CLI",
        command: this.#command,
        args,
        stdin: request.responseFormat === "json" && request.responseSchema === undefined
          ? `${prompt}\n\nReturn a valid JSON object only.`
          : prompt,
        timeoutMs: this.#timeoutMs,
        // API keys in the environment would make the CLI bill the API instead of the subscription.
        withoutEnvironment: ["OPENAI_API_KEY", "CODEX_API_KEY"],
      });
      const text = (await readFile(outputFile, "utf8").catch(() => "")).trim();
      if (text === "") {
        throw new ProviderError("Codex CLI produced no answer; check `codex login status`", "codex-cli");
      }
      return { provider: this.id, model: request.model, text, finishReason: "end_turn" };
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
}
