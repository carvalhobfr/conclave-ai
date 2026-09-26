import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

import { expectOwnerOnlyFile } from "./helpers/file-mode.js";

import {
  languageFromEnvironment,
  loadUserPreferences,
  parseInterfaceLanguage,
  setInterfaceLanguage,
  userPreferencesPath,
} from "../src/config/user-preferences.js";
import { cliHelp } from "../src/i18n/cli-copy.js";

describe("CLI user preferences", () => {
  it("defaults to English without creating a preferences file", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-preferences-"));
    const path = join(root, "config.json");
    try {
      const loaded = await loadUserPreferences(path);
      expect(loaded.exists).toBe(false);
      expect(loaded.preferences.language).toBe("en");
      expect(languageFromEnvironment(loaded.preferences.language, {}, loaded.exists)).toEqual({
        language: "en",
        source: "default",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("persists a normalized language as an owner-only global preference", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-preferences-"));
    const path = join(root, "nested", "config.json");
    try {
      await setInterfaceLanguage(parseInterfaceLanguage("pt-br"), path);
      await chmod(path, 0o644);
      await setInterfaceLanguage(parseInterfaceLanguage("pt-br"), path);
      const loaded = await loadUserPreferences(path);
      expect(loaded).toEqual(expect.objectContaining({
        exists: true,
        preferences: { schemaVersion: 1, language: "pt-BR" },
      }));
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ schemaVersion: 1, language: "pt-BR" });
      await expectOwnerOnlyFile(path);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports a one-process environment override without changing preferences", () => {
    expect(languageFromEnvironment("pt-BR", { CONCLAVE_LANGUAGE: "es" }, true)).toEqual({
      language: "es-ES",
      source: "environment",
    });
  });

  it("rejects malformed and unsupported preference files with an actionable error", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-preferences-"));
    const path = join(root, "config.json");
    try {
      await writeFile(path, JSON.stringify({ schemaVersion: 1, language: "fr-FR" }), "utf8");
      await expect(loadUserPreferences(path)).rejects.toThrow("Use en, pt-BR, or es-ES");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves the standard user configuration locations", () => {
    // The function stores preferences on the machine it runs on, so it resolves with the host
    // separator. Building the expectation the same way keeps the contract under test — which
    // directory wins — instead of asserting POSIX separators on every platform.
    expect(userPreferencesPath({ XDG_CONFIG_HOME: "/tmp/xdg" }, "/users/demo", "linux"))
      .toBe(resolve("/tmp/xdg", "conclave", "config.json"));
    expect(userPreferencesPath({}, "/users/demo", "linux"))
      .toBe(["/users/demo", ".config", "conclave", "config.json"].join(sep).replace(/\//gu, sep));
    expect(userPreferencesPath({ APPDATA: "C:\\Users\\demo\\AppData" }, "C:\\Users\\demo", "win32"))
      .toContain(join("Conclave", "config.json"));
  });

  it("renders a complete localized command catalog and detailed command help", () => {
    const english = cliHelp("en");
    expect(english).toContain("PR workflow");
    expect(english).toContain("check");
    expect(english).toContain("eval-reasoning");
    expect(english).toContain("config --language pt-BR");

    const portuguese = cliHelp("pt-BR", "symbol");
    expect(portuguese).toContain("unidade de código nomeada");
    expect(portuguese).toContain("conclave symbol . SuperValidator");

    const spanish = cliHelp("es-ES", "config");
    expect(spanish).toContain("Precedencia: entorno del shell");
    expect(spanish).toContain("conclave config set api-key");

    const commands = [
      "scan", "index", "search", "retrieve", "symbol", "text", "graph", "path",
      "ask", "investigate", "check", "review", "validate", "pr", "compare", "history",
      "handoff", "doctor", "setup", "open", "update", "start", "eval", "eval-graph",
      "eval-reasoning", "config", "models", "init", "skill", "provider-check", "mcp", "demo", "help",
    ];
    for (const command of commands) {
      expect(cliHelp("en", command), command).toContain(`Conclave · ${command}`);
    }
  });
});
