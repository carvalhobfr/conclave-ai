import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { maskValue, resolveConfigKey, validateConfigValue } from "../src/config/config-keys.js";
import {
  activeEnvironmentPath,
  globalEnvironmentPath,
  loadConclaveEnvironment,
  updateConclaveEnvironment,
} from "../src/config/environment-file.js";

describe("config keys", () => {
  it("accepts short aliases and raw names", () => {
    expect(resolveConfigKey("api-key")).toBe("CONCLAVE_API_KEY");
    expect(resolveConfigKey("key")).toBe("CONCLAVE_API_KEY");
    expect(resolveConfigKey("endpoint")).toBe("CONCLAVE_BASE_URL");
    expect(resolveConfigKey("judge-model")).toBe("CONCLAVE_JUDGE_MODEL");
    expect(resolveConfigKey("CONCLAVE_MODEL")).toBe("CONCLAVE_MODEL");
    expect(() => resolveConfigKey("bad key!")).toThrow(/Invalid setting/);
  });

  it("never prints secrets in full", () => {
    expect(maskValue("CONCLAVE_API_KEY", "sk-abcdefghijklmnop1234")).toBe("sk-…1234");
    expect(maskValue("CONCLAVE_API_KEY", "short")).not.toContain("short");
    expect(maskValue("CONCLAVE_MODEL", "deepseek")).toBe("deepseek");
  });

  it("rejects values the runtime would refuse", () => {
    expect(() => validateConfigValue("CONCLAVE_MODE", "cloud")).toThrow(/api, local, free/);
    expect(validateConfigValue("CONCLAVE_MODE", " api ")).toBe("api");
  });
});

describe("user settings file", () => {
  it("lives next to the global preferences", () => {
    expect(globalEnvironmentPath({ CONCLAVE_CONFIG_HOME: "/tmp/conclave-home" })).toBe("/tmp/conclave-home/credentials.env");
  });

  it("prefers a project .env only when it already defines Conclave keys", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-active-"));
    try {
      const environment = { CONCLAVE_CONFIG_HOME: join(root, "home") };
      const project = join(root, ".env");
      expect(activeEnvironmentPath(project, environment)).toBe(join(root, "home", "credentials.env"));
      await writeFile(project, "OTHER=1\n");
      expect(activeEnvironmentPath(project, environment)).toBe(join(root, "home", "credentials.env"));
      await writeFile(project, "CONCLAVE_MODEL=x\n");
      expect(activeEnvironmentPath(project, environment)).toBe(project);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("merges updates, removes keys, and creates the directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-update-"));
    try {
      const path = join(root, "nested", "credentials.env");
      await updateConclaveEnvironment(path, { CONCLAVE_PROVIDER: "openai", CONCLAVE_API_KEY: "secret" });
      await updateConclaveEnvironment(path, { CONCLAVE_MODEL: "gpt", CONCLAVE_PROVIDER: undefined });
      const content = await readFile(path, "utf8");
      expect(content).toContain('CONCLAVE_API_KEY="secret"');
      expect(content).toContain('CONCLAVE_MODEL="gpt"');
      expect(content).not.toContain("CONCLAVE_PROVIDER");
      const environment: NodeJS.ProcessEnv = { CONCLAVE_MODEL: "from-shell" };
      loadConclaveEnvironment(environment, path);
      expect(environment["CONCLAVE_MODEL"]).toBe("from-shell");
      expect(environment["CONCLAVE_API_KEY"]).toBe("secret");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
