import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { expectOwnerOnlyFile } from "./helpers/file-mode.js";

import { loadConclaveEnvironment, writeConclaveEnvironment } from "../src/config/environment-file.js";
import { providerProfiles } from "../src/config/provider-profiles.js";
import { createSetupConfiguration } from "../src/config/setup.js";

describe("guided setup", () => {
  it("offers maintained starting profiles for every hosted provider", () => {
    expect(providerProfiles("openai")).toHaveLength(4);
    expect(providerProfiles("openrouter")).toHaveLength(4);
    expect(providerProfiles("anthropic")).toHaveLength(4);
    expect(providerProfiles("opencode-go").map((profile) => profile.model)).toEqual(["deepseek-v4.1-flash", "space-bunny-free"]);
  });

  it("builds API-mode configuration without changing deterministic validation", () => {
    const setup = createSetupConfiguration({
      provider: "openrouter",
      profileId: "claude-sonnet-latest",
      reasoningStyleId: "fast",
      apiKey: "key-only-for-test",
    });

    expect(setup).toEqual(expect.objectContaining({
      provider: "openrouter",
      model: "~anthropic/claude-sonnet-latest",
      reasoningPreset: "free-like",
      credentialSaved: true,
    }));
    expect(setup.environment).toEqual(expect.objectContaining({
      CONCLAVE_MODE: "api",
      CONCLAVE_PROVIDER: "openrouter",
      CONCLAVE_API_KEY: "key-only-for-test",
    }));
  });

  it("keeps unrelated local variables, replaces only its managed block, and preserves explicit process values", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-setup-"));
    const path = join(root, ".env");
    try {
      await writeFile(path, "UNRELATED=value\nCONCLAVE_MODE=free\n", "utf8");
      await chmod(path, 0o644);
      await writeConclaveEnvironment(path, {
        CONCLAVE_MODE: "api",
        CONCLAVE_PROVIDER: "anthropic",
        CONCLAVE_MODEL: "claude-sonnet-5",
        CONCLAVE_API_KEY: "test-key",
      });
      await writeConclaveEnvironment(path, {
        CONCLAVE_MODE: "api",
        CONCLAVE_PROVIDER: "anthropic",
        CONCLAVE_MODEL: "claude-opus-5",
      });

      const contents = await readFile(path, "utf8");
      expect(contents).toContain("UNRELATED=value");
      expect(contents).toContain("CONCLAVE_MODEL=\"claude-opus-5\"");
      expect(contents).not.toContain("test-key");
      await expectOwnerOnlyFile(path);

      const environment: NodeJS.ProcessEnv = { CONCLAVE_PROVIDER: "openai" };
      const loaded = loadConclaveEnvironment(environment, path);
      expect(loaded.loadedKeys).toContain("CONCLAVE_MODEL");
      expect(environment).toEqual(expect.objectContaining({
        CONCLAVE_MODE: "api",
        CONCLAVE_PROVIDER: "openai",
        CONCLAVE_MODEL: "claude-opus-5",
      }));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
