import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { parseArguments } from "../src/cli-arguments.js";
import { PLUGIN_SCHEMAS, pluginManifest, readPluginSchema, renderPluginManifest, type PluginManifest } from "../src/workflow/plugin-manifest.js";
import { buildArgv, readPath, type HostValue } from "./helpers/plugin-host.js";

const manifest: PluginManifest = pluginManifest("9.9.9");

interface ManifestSchema {
  readonly properties: Record<string, unknown>;
  readonly $defs: Readonly<Record<"parameter" | "command" | "widget" | "action", { readonly properties: Record<string, unknown> }>>;
}

async function manifestSchema(): Promise<ManifestSchema> {
  return JSON.parse(await readFile(resolve("schemas/plugin-manifest.v1.schema.json"), "utf8")) as ManifestSchema;
}

function command(id: string) {
  const found = manifest.commands.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`No command ${id}`);
  return found;
}

describe("plugin manifest", () => {
  it("states the safety guarantees a host relies on", () => {
    expect(manifest.version).toBe("9.9.9");
    expect(manifest.invocation).toEqual({ executable: "conclave", shell: false });
    expect(manifest.safety).toEqual({
      readOnly: true,
      mutatesRepository: false,
      usesNetwork: false,
      callsModel: false,
      executesRepositoryCode: false,
    });
  });

  it("has unique ids and widgets and actions that point at real commands and parameters", () => {
    for (const group of [manifest.commands, manifest.widgets, manifest.actions]) {
      const ids = group.map((item) => item.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    for (const item of [...manifest.widgets, ...manifest.actions]) {
      const target = command(item.command);
      const parameters = new Map(target.parameters.map((parameter) => [parameter.name, parameter]));
      for (const [name, value] of Object.entries(item.arguments)) {
        const parameter = parameters.get(name);
        expect(parameter, `${item.id} sets unknown parameter ${name}`).toBeDefined();
        if (parameter?.type === "switch") expect(typeof value).toBe("boolean");
        if (parameter?.type === "integer") {
          expect(typeof value).toBe("number");
          expect(value as number).toBeGreaterThanOrEqual(parameter.minimum ?? Number.NEGATIVE_INFINITY);
          expect(value as number).toBeLessThanOrEqual(parameter.maximum ?? Number.POSITIVE_INFINITY);
        }
      }
    }
    for (const action of manifest.actions) {
      const target = command(action.command);
      const names = new Set(target.parameters.map((parameter) => parameter.name));
      for (const bound of action.binds) expect(names.has(bound), `${action.id} binds unknown ${bound}`).toBe(true);
      // Whatever is neither fixed nor bound must be optional, or the host could not run the action.
      const missing = target.parameters.filter((parameter) => parameter.required && !(parameter.name in action.arguments) && !action.binds.includes(parameter.name));
      expect(missing.map((parameter) => parameter.name), `${action.id} leaves required parameters unfilled`).toEqual([]);
    }
    for (const widget of manifest.widgets) {
      const target = command(widget.command);
      expect(target.output.format).toBe("json");
      const missing = target.parameters.filter((parameter) => parameter.required && !(parameter.name in widget.arguments));
      // A widget is placed on a repository (or a list of them) by the host; only that parameter may stay open.
      expect(missing.every((parameter) => parameter.type === "repository" || parameter.type === "repositories")).toBe(true);
    }
  });

  it("declares every effect a command has and keeps the cheap ones cheap", () => {
    expect(command("status").effects).toEqual([]);
    expect(command("commits").effects).toEqual([]);
    expect(command("check").effects).toContain("writes-conclave-state");
    expect(command("open-cockpit").longRunning).toBe(true);
    expect(manifest.commands.filter((item) => item.longRunning).map((item) => item.id)).toEqual(["open-cockpit"]);
    // Anything that can index a whole tree per item must say so.
    expect(command("commits").cost).toBe("high");
    expect(command("check").resultExitCodes).toEqual({ "0": "pass or warn", "1": "block", "2": "inconclusive" });
    for (const widget of manifest.widgets.filter((item) => item.arguments["analyze"] === true)) {
      expect(widget.refresh.minIntervalSeconds).toBeGreaterThanOrEqual(300);
    }
  });

  it("references schemas that are published, parse and carry a matching $id", async () => {
    const declared = new Set(PLUGIN_SCHEMAS.map((entry) => entry.id));
    for (const item of manifest.commands) {
      if (item.output.schema !== undefined) expect(declared.has(item.output.schema), `${item.id} -> ${item.output.schema}`).toBe(true);
    }
    for (const entry of manifest.schemas) {
      const parsed = JSON.parse(await readFile(resolve(entry.file), "utf8")) as { $id?: string };
      expect(parsed.$id?.endsWith(`/${entry.file.replace("schemas/", "")}`), entry.id).toBe(true);
    }
  });

  it("builds argv the real parser accepts, with every flag taking effect", () => {
    const check = parseArguments(buildArgv(command("check"), { repository: "/repo", base: "origin/main", objective: "Keep refunds" }).slice(1));
    expect(check).toEqual(expect.objectContaining({ positionals: ["/repo"], branch: "origin/main", objective: "Keep refunds", json: true }));

    const commits = parseArguments(buildArgv(command("commits"), { repository: "/repo", base: "main", head: "feature", limit: 7, analyze: true }).slice(1));
    expect(commits).toEqual(expect.objectContaining({ positionals: ["/repo"], branch: "main", head: "feature", limit: 7, analyze: true, json: true }));
    expect(parseArguments(buildArgv(command("commits"), { repository: "/repo", analyze: false }).slice(1)).analyze).toBe(false);

    const status = parseArguments(buildArgv(command("status"), { repositories: ["/a", "/b"] }).slice(1));
    expect(status.positionals).toEqual(["/a", "/b"]);

    expect(parseArguments(buildArgv(command("handoff"), { repository: "/repo" }).slice(1)).positionals).toEqual(["/repo"]);
    expect(buildArgv(command("open-cockpit"), { repository: "/repo", port: 4400 })).toEqual(["open", "--no-browser", "/repo", "--port", "4400"]);
  });

  it("builds the argv of every widget and action from its fixed arguments", () => {
    for (const item of [...manifest.widgets, ...manifest.actions]) {
      const target = command(item.command);
      const values: Record<string, HostValue> = { ...item.arguments };
      for (const parameter of target.parameters) {
        if (parameter.type === "repository") values[parameter.name] = "/repo";
        if (parameter.type === "repositories") values[parameter.name] = ["/repo"];
      }
      const argv = buildArgv(target, values);
      if (target.id !== "open-cockpit") expect(() => parseArguments(argv.slice(1)), item.id).not.toThrow();
    }
  });

  it("declares only fields its published schema declares", async () => {
    const schema = await manifestSchema();
    const undeclared = (value: object, declared: Record<string, unknown>): string[] => Object.keys(value).filter((key) => !(key in declared));
    expect(undeclared(manifest, schema.properties)).toEqual([]);
    for (const item of manifest.commands) {
      expect(undeclared(item, schema.$defs.command.properties), item.id).toEqual([]);
      for (const parameter of item.parameters) expect(undeclared(parameter, schema.$defs.parameter.properties), parameter.name).toEqual([]);
    }
    for (const item of manifest.widgets) expect(undeclared(item, schema.$defs.widget.properties), item.id).toEqual([]);
    for (const item of manifest.actions) expect(undeclared(item, schema.$defs.action.properties), item.id).toEqual([]);
  });

  it("serves a schema by id and reads nothing else", async () => {
    const text = await readPluginSchema(resolve("."), "status.v1");
    expect((JSON.parse(text) as { $id: string }).$id).toContain("status.v1.schema.json");
    await expect(readPluginSchema(resolve("."), "../package")).rejects.toThrow("Unknown schema");
    await expect(readPluginSchema(resolve("."), "nope")).rejects.toThrow("Available: status.v1");
  });

  it("renders a readable summary", () => {
    const text = renderPluginManifest(manifest);
    expect(text).toContain("Conclave 9.9.9");
    expect(text).toContain("check: Check changes [writes-conclave-state; cost high]");
    expect(text).toContain("repository-health");
  });

  it("resolves manifest field paths", () => {
    expect(readPath({ summary: { dirty: 2 } }, "summary.dirty")).toEqual([2]);
    expect(readPath({ commits: [{ shortSha: "a" }, { shortSha: "b" }] }, "commits[].shortSha")).toEqual(["a", "b"]);
    expect(readPath({ summary: {} }, "summary.dirty")).toEqual([]);
  });
});
