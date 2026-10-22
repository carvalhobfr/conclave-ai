import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { ProviderError } from "../src/domain/provider.js";
import { ClaudeCliProvider } from "../src/providers/claude-cli-provider.js";
import { createProvider } from "../src/providers/provider-factory.js";
import { EnvironmentCredentialSource } from "../src/storage/environment-credential-source.js";

// Stands in for the `claude` binary: echoes its argv, stdin and env so the tests can check the contract.
const FAKE_CLAUDE = `#!/usr/bin/env node
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (mode === "garbage") { process.stdout.write("not json"); return; }
  if (mode === "error") {
    process.stdout.write(JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: true, result: "too many turns" }));
    return;
  }
  const args = process.argv.slice(2);
  const schemaIndex = args.indexOf("--json-schema");
  process.stdout.write(JSON.stringify({
    type: "result",
    subtype: "success",
    is_error: false,
    result: JSON.stringify({ args, prompt, hasAnthropicKey: "ANTHROPIC_API_KEY" in process.env }),
    ...(schemaIndex === -1 ? {} : { structured_output: { answer: "structured" } }),
    usage: { input_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 7, output_tokens: 5 },
  }));
});
`;

describe("ClaudeCliProvider", () => {
  let command: string;

  beforeAll(() => {
    const directory = mkdtempSync(join(tmpdir(), "conclave-claude-cli-"));
    command = join(directory, "fake-claude");
    writeFileSync(command, FAKE_CLAUDE);
    chmodSync(command, 0o755);
  });

  afterEach(() => {
    delete process.env["FAKE_CLAUDE_MODE"];
    delete process.env["ANTHROPIC_API_KEY"];
  });

  it("sends the system prompt as a flag, the user turn on stdin, and no tools", async () => {
    const provider = new ClaudeCliProvider({ command });
    const response = await provider.generate({
      model: "sonnet",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Question?" },
      ],
    });
    const echoed = JSON.parse(response.text) as { args: string[]; prompt: string };
    expect(echoed.prompt).toBe("Question?");
    expect(echoed.args).toEqual(expect.arrayContaining(["--print", "--output-format", "json", "--model", "sonnet", "--tools", "", "--system-prompt", "Be terse."]));
    expect(echoed.args).toContain("--no-session-persistence");
    expect(echoed.args).not.toContain("--json-schema");
    expect(response).toMatchObject({ provider: "claude-cli", model: "sonnet", usage: { inputTokens: 20, outputTokens: 5 } });
  });

  it("returns structured output as JSON text when a schema is given", async () => {
    const provider = new ClaudeCliProvider({ command });
    const response = await provider.generate({
      model: "sonnet",
      messages: [{ role: "user", content: "Structured?" }],
      responseSchema: { type: "object" },
    });
    expect(JSON.parse(response.text)).toEqual({ answer: "structured" });
  });

  it("removes ANTHROPIC_API_KEY so the subscription login is used", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-should-not-leak";
    const provider = new ClaudeCliProvider({ command });
    const response = await provider.generate({ model: "sonnet", messages: [{ role: "user", content: "x" }] });
    expect(JSON.parse(response.text)).toMatchObject({ hasAnthropicKey: false });
  });

  it("raises a provider error when the CLI reports an error", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "error";
    const provider = new ClaudeCliProvider({ command });
    await expect(provider.generate({ model: "sonnet", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(new ProviderError("Claude CLI failed: too many turns", "claude-cli"));
  });

  it("raises a provider error on non-JSON output", async () => {
    process.env["FAKE_CLAUDE_MODE"] = "garbage";
    const provider = new ClaudeCliProvider({ command });
    await expect(provider.generate({ model: "sonnet", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow("Claude CLI returned non-JSON output");
  });

  it("reports a missing binary as a provider error", async () => {
    const provider = new ClaudeCliProvider({ command: join(tmpdir(), "conclave-no-such-binary") });
    await expect(provider.generate({ model: "sonnet", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow("Claude CLI could not start");
  });

  it("is selected by the factory without an API key or base URL", () => {
    const environment = { CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: "claude-cli", CONCLAVE_MODEL: "sonnet" };
    const provider = createProvider(loadRuntimeConfig(environment), new EnvironmentCredentialSource(environment));
    expect(provider.id).toBe("claude-cli");
  });
});
