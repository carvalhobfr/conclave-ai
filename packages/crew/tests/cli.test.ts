import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { temporaryRepository } from "./helpers.js";

const cli = resolve(import.meta.dirname, "../dist/cli.js");
const version = (JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")) as { version: string }).version;
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function crew(cwd: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  try {
    return { status: 0, stdout: execFileSync(process.execPath, [cli, ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "" };
  } catch (error) {
    const failure = error as { status: number; stdout: string; stderr: string };
    return { status: failure.status, stdout: failure.stdout, stderr: failure.stderr };
  }
}

describe.skipIf(!existsSync(cli))("the built command", () => {
  it("prints its version and help", () => {
    expect(crew(process.cwd(), "--version").stdout.trim()).toBe(version);
    expect(crew(process.cwd(), "help").stdout).toContain("Crew never merges");
  });

  it("keeps tasks and refuses Codex as driver", () => {
    const repository = temporaryRepository();
    cleanups.push(repository.cleanup);
    expect(crew(repository.path, "tasks", "add", "Add sub").status).toBe(0);
    const listed = JSON.parse(crew(repository.path, "tasks", "list", "--json").stdout) as { tasks: { objective: string }[] };
    expect(listed.tasks.map((task) => task.objective)).toEqual(["Add sub"]);
    const refused = crew(repository.path, "crew", "set", "--driver", "codex", "--navigator", "claude");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/codex can't be the driver/);
  });

  it("prints a manifest whose changing actions require confirmation", () => {
    const manifest = JSON.parse(crew(process.cwd(), "plugin", "manifest").stdout) as { id: string; version: string; actions: { id: string; confirmation: string }[] };
    expect(manifest.id).toBe("conclave-crew");
    expect(manifest.version).toBe(version);
    expect(Object.fromEntries(manifest.actions.map((action) => [action.id, action.confirmation]))).toEqual({
      "start-run": "required", "stop-run": "none", "discard-run": "required",
    });
  });
});
