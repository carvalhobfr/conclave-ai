import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { loadRuntimeConfig } from "../src/config/runtime-config.js";
import { ProviderError } from "../src/domain/provider.js";
import { CodexCliProvider } from "../src/providers/codex-cli-provider.js";
import { createProvider } from "../src/providers/provider-factory.js";
import { EnvironmentCredentialSource } from "../src/storage/environment-credential-source.js";

// Stands in for the `codex` binary: honours `--output-last-message` and `--output-schema`, and records argv and stdin.
const FAKE_CODEX = `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const prompt = Buffer.concat(chunks).toString("utf8");
  if (mode === "fail") {
    process.stderr.write("not logged in");
    process.exit(1);
  }
  const outputIndex = args.indexOf("--output-last-message");
  const schemaIndex = args.indexOf("--output-schema");
  const echoed = { args, prompt, hasOpenAiKey: "OPENAI_API_KEY" in process.env };
  if (mode !== "empty" && outputIndex !== -1) {
    const answer = schemaIndex === -1 ? JSON.stringify(echoed) : JSON.stringify({ answer: "structured", schema: JSON.parse(readFileSync(args[schemaIndex + 1], "utf8")).type });
    writeFileSync(args[outputIndex + 1], answer);
  }
  process.stdout.write("codex transcript\\n");
});
`;

describe("CodexCliProvider", () => {
  let command: string;

  beforeAll(() => {
    const directory = mkdtempSync(join(tmpdir(), "conclave-codex-cli-"));
    command = join(directory, "fake-codex");
    writeFileSync(command, FAKE_CODEX);
    chmodSync(command, 0o755);
  });

  afterEach(() => {
    delete process.env["FAKE_CODEX_MODE"];
    delete process.env["OPENAI_API_KEY"];
  });

  it("runs read-only with user config ignored, sends system text first, and reads the answer file", async () => {
    const provider = new CodexCliProvider({ command });
    const response = await provider.generate({
      model: "gpt-6-astra",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "Question?" },
      ],
    });
    const echoed = JSON.parse(response.text) as { args: string[]; prompt: string };
    expect(echoed.args).toEqual(expect.arrayContaining(["exec", "--ephemeral", "--ignore-user-config", "--sandbox", "read-only", "--model", "gpt-6-astra", "--output-last-message"]));
    expect(echoed.args.at(-1)).toBe("-");
    expect(echoed.prompt).toBe("Be terse.\n\nQuestion?");
    expect(response).toMatchObject({ provider: "codex-cli", model: "gpt-6-astra", finishReason: "end_turn" });
  });

  it("passes the schema file and returns the structured answer", async () => {
    const provider = new CodexCliProvider({ command });
    const response = await provider.generate({
      model: "gpt-6-astra",
      messages: [{ role: "user", content: "Structured?" }],
      responseSchema: { type: "object" },
    });
    expect(JSON.parse(response.text)).toEqual({ answer: "structured", schema: "object" });
  });

  it("removes OPENAI_API_KEY so the ChatGPT login is used", async () => {
    process.env["OPENAI_API_KEY"] = "sk-should-not-leak";
    const provider = new CodexCliProvider({ command });
    const response = await provider.generate({ model: "gpt-6-astra", messages: [{ role: "user", content: "x" }] });
    expect(JSON.parse(response.text)).toMatchObject({ hasOpenAiKey: false });
  });

  it("raises a provider error when no answer file is written", async () => {
    process.env["FAKE_CODEX_MODE"] = "empty";
    const provider = new CodexCliProvider({ command });
    await expect(provider.generate({ model: "gpt-6-astra", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow(new ProviderError("Codex CLI produced no answer; check `codex login status`", "codex-cli"));
  });

  it("surfaces a non-zero exit with stderr when there is no output", async () => {
    process.env["FAKE_CODEX_MODE"] = "fail";
    const provider = new CodexCliProvider({ command });
    await expect(provider.generate({ model: "gpt-6-astra", messages: [{ role: "user", content: "x" }] }))
      .rejects.toThrow("Codex CLI exited with code 1: not logged in");
  });

  it("is selected by the factory without an API key or endpoint, and honours CONCLAVE_CODEX_COMMAND", () => {
    const environment = { CONCLAVE_MODE: "api", CONCLAVE_PROVIDER: "codex-cli", CONCLAVE_MODEL: "gpt-6-astra", CONCLAVE_CODEX_COMMAND: command };
    const provider = createProvider(loadRuntimeConfig(environment), new EnvironmentCredentialSource(environment));
    expect(provider.id).toBe("codex-cli");
  });
});
