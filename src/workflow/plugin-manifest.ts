import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const PLUGIN_MANIFEST_SCHEMA_VERSION = 1;
/** Bumped only for a change a host written against the previous protocol would misread. */
export const PLUGIN_PROTOCOL = 1;

export type PluginParameterType = "repository" | "repositories" | "git-ref" | "integer" | "switch" | "text";
export type PluginEffect = "writes-conclave-state" | "starts-local-server";

export interface PluginParameter {
  readonly name: string;
  readonly type: PluginParameterType;
  readonly description: string;
  readonly required: boolean;
  /** Absent for a positional parameter. A `switch` is passed as the flag alone; any other type as the flag and its value. */
  readonly flag?: string;
  readonly minimum?: number;
  readonly maximum?: number;
}

export interface PluginCommand {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  /** Leading arguments, always passed. The host appends positional parameters in declared order, then each provided flag. */
  readonly argv: readonly string[];
  readonly parameters: readonly PluginParameter[];
  readonly output: {
    readonly format: "json" | "text";
    /** Id of a schema served by `conclave plugin schema <id>`. */
    readonly schema?: string;
    /** Key of the payload that holds the document the schema describes; the payload itself when absent. */
    readonly at?: string;
  };
  /** Exit codes that are results, not failures. Any other non-zero code is an error. */
  readonly resultExitCodes: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
  readonly cost: "low" | "high";
  /** Everything the command does besides reading. Empty means it only reads. */
  readonly effects: readonly PluginEffect[];
  /** True for a command that keeps running until the host stops it. */
  readonly longRunning: boolean;
}

export interface PluginWidget {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly command: string;
  /** Values for the command's parameters, fixed by the widget. */
  readonly arguments: Readonly<Record<string, string | number | boolean>>;
  readonly sizes: readonly ("small" | "medium" | "large")[];
  readonly refresh: { readonly minIntervalSeconds: number };
  /** Paths into the command's JSON output that the widget shows; `[]` marks every item of an array. */
  readonly fields: readonly { readonly label: string; readonly path: string }[];
}

export interface PluginAction {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly command: string;
  readonly arguments: Readonly<Record<string, string | number | boolean>>;
  /** Parameters the host fills in when the action runs. */
  readonly binds: readonly string[];
  /** Every action here leaves the repository untouched, so none asks for confirmation. */
  readonly confirmation: "none";
}

export interface PluginSchemaEntry {
  readonly id: string;
  readonly file: string;
}

export interface PluginManifest {
  readonly schemaVersion: typeof PLUGIN_MANIFEST_SCHEMA_VERSION;
  readonly protocol: typeof PLUGIN_PROTOCOL;
  readonly id: "conclave";
  readonly name: "Conclave";
  /** The installed conclave-ai version. */
  readonly version: string;
  readonly description: string;
  readonly invocation: {
    readonly executable: "conclave";
    /** Pass each argument as its own argv element; never build a command line for a shell. */
    readonly shell: false;
  };
  readonly requires: readonly string[];
  readonly safety: {
    readonly readOnly: true;
    readonly mutatesRepository: false;
    readonly usesNetwork: false;
    readonly callsModel: false;
    readonly executesRepositoryCode: false;
  };
  readonly commands: readonly PluginCommand[];
  readonly widgets: readonly PluginWidget[];
  readonly actions: readonly PluginAction[];
  readonly schemas: readonly PluginSchemaEntry[];
}

export const PLUGIN_SCHEMAS: readonly PluginSchemaEntry[] = [
  { id: "status.v1", file: "schemas/status.v1.schema.json" },
  { id: "commit-timeline.v1", file: "schemas/commit-timeline.v1.schema.json" },
  { id: "validation-report.v5", file: "schemas/validation-report.v5.schema.json" },
  { id: "plugin-manifest.v1", file: "schemas/plugin-manifest.v1.schema.json" },
];

const REPOSITORY: PluginParameter = { name: "repository", type: "repository", description: "A folder inside a Git repository.", required: true };
const BASE: PluginParameter = { name: "base", type: "git-ref", description: "Comparison base.", required: false, flag: "--base" };

const COMMANDS: readonly PluginCommand[] = [
  {
    id: "status",
    title: "Repository status",
    description: "Branch, upstream, uncommitted work and the last saved review of one or more repositories.",
    argv: ["status", "--json"],
    parameters: [{ name: "repositories", type: "repositories", description: "Up to 50 repository folders.", required: true }],
    output: { format: "json", schema: "status.v1" },
    resultExitCodes: { "0": "snapshot produced" },
    timeoutSeconds: 30,
    cost: "low",
    effects: [],
    longRunning: false,
  },
  {
    id: "commits",
    title: "Commit timeline",
    description: "Recent commits, newest first; optionally the deterministic review of each.",
    argv: ["commits", "--json"],
    parameters: [
      REPOSITORY,
      BASE,
      { name: "head", type: "git-ref", description: "Tip of the listing; HEAD by default.", required: false, flag: "--head" },
      { name: "limit", type: "integer", description: "Commits to list (at most 25 with analyze).", required: false, flag: "--limit", minimum: 1, maximum: 100 },
      { name: "analyze", type: "switch", description: "Run the deterministic review on each commit.", required: false, flag: "--analyze" },
    ],
    output: { format: "json", schema: "commit-timeline.v1" },
    resultExitCodes: { "0": "timeline produced" },
    timeoutSeconds: 600,
    cost: "high",
    effects: [],
    longRunning: false,
  },
  {
    id: "check",
    title: "Check changes",
    description: "Review the current branch and every local change; the report is saved to local history.",
    argv: ["check", "--json"],
    parameters: [
      REPOSITORY,
      BASE,
      { name: "objective", type: "text", description: "What the change should deliver.", required: false, flag: "--objective" },
    ],
    output: { format: "json", schema: "validation-report.v5", at: "report" },
    resultExitCodes: { "0": "pass or warn", "1": "block", "2": "inconclusive" },
    timeoutSeconds: 300,
    cost: "high",
    effects: ["writes-conclave-state"],
    longRunning: false,
  },
  {
    id: "handoff",
    title: "Agent prompt",
    description: "The correction request for a coding agent, from the latest saved review.",
    argv: ["handoff", "--json"],
    parameters: [REPOSITORY],
    output: { format: "json" },
    resultExitCodes: { "0": "handoff produced" },
    timeoutSeconds: 30,
    cost: "low",
    effects: [],
    longRunning: false,
  },
  {
    id: "open-cockpit",
    title: "Open the cockpit",
    description: "Start the read-only local review cockpit. The line `Conclave cockpit: <url>` names the loopback address; stopping the process stops the cockpit.",
    argv: ["open", "--no-browser"],
    parameters: [
      REPOSITORY,
      { name: "port", type: "integer", description: "Loopback port; 4317, or the next free one, by default.", required: false, flag: "--port", minimum: 1, maximum: 65535 },
    ],
    output: { format: "text" },
    resultExitCodes: { "0": "cockpit stopped" },
    timeoutSeconds: 45,
    cost: "low",
    effects: ["starts-local-server", "writes-conclave-state"],
    longRunning: true,
  },
];

const WIDGETS: readonly PluginWidget[] = [
  {
    id: "repository-health",
    title: "Repository health",
    description: "How many repositories have uncommitted work, a blocked review or no current review.",
    command: "status",
    arguments: {},
    sizes: ["small", "medium"],
    refresh: { minIntervalSeconds: 60 },
    fields: [
      { label: "Uncommitted", path: "summary.dirty" },
      { label: "Blocked", path: "summary.blocked" },
      { label: "Needs review", path: "summary.needsReview" },
    ],
  },
  {
    id: "recent-commits",
    title: "Recent commits",
    description: "The latest commits of a repository.",
    command: "commits",
    arguments: { limit: 5 },
    sizes: ["medium", "large"],
    refresh: { minIntervalSeconds: 120 },
    fields: [
      { label: "Commit", path: "commits[].shortSha" },
      { label: "Subject", path: "commits[].subject" },
      { label: "Author", path: "commits[].author" },
      { label: "Date", path: "commits[].authoredAt" },
    ],
  },
  {
    id: "commit-verdicts",
    title: "Commit verdicts",
    description: "Verdicts of the deterministic review over the latest commits. Indexes every commit, so it refreshes slowly.",
    command: "commits",
    arguments: { limit: 10, analyze: true },
    sizes: ["medium"],
    refresh: { minIntervalSeconds: 600 },
    fields: [
      { label: "Pass", path: "summary.verdicts.pass" },
      { label: "Warn", path: "summary.verdicts.warn" },
      { label: "Block", path: "summary.verdicts.block" },
      { label: "Inconclusive", path: "summary.verdicts.inconclusive" },
    ],
  },
];

const ACTIONS: readonly PluginAction[] = [
  {
    id: "check-repository",
    title: "Check changes",
    description: "Review the branch and every local change of a repository.",
    command: "check",
    arguments: {},
    binds: ["repository"],
    confirmation: "none",
  },
  {
    id: "review-last-commit",
    title: "Review the last commit",
    description: "Run the deterministic review on the latest commit.",
    command: "commits",
    arguments: { limit: 1, analyze: true },
    binds: ["repository"],
    confirmation: "none",
  },
  {
    id: "show-agent-prompt",
    title: "Show agent prompt",
    description: "The correction request for a coding agent from the latest review.",
    command: "handoff",
    arguments: {},
    binds: ["repository"],
    confirmation: "none",
  },
  {
    id: "open-cockpit",
    title: "Open the cockpit",
    description: "Start the local review cockpit for a repository.",
    command: "open-cockpit",
    arguments: {},
    binds: ["repository"],
    confirmation: "none",
  },
];

/** What a host (a dashboard, a launcher, an app with widgets) needs to drive Conclave without knowing its CLI. */
export function pluginManifest(version: string): PluginManifest {
  return {
    schemaVersion: PLUGIN_MANIFEST_SCHEMA_VERSION,
    protocol: PLUGIN_PROTOCOL,
    id: "conclave",
    name: "Conclave",
    version,
    description: "Graph-aware, read-only validator for code changes: repository status, commit analysis and review reports.",
    invocation: { executable: "conclave", shell: false },
    requires: ["git"],
    safety: { readOnly: true, mutatesRepository: false, usesNetwork: false, callsModel: false, executesRepositoryCode: false },
    commands: COMMANDS,
    widgets: WIDGETS,
    actions: ACTIONS,
    schemas: PLUGIN_SCHEMAS,
  };
}

/** One of the published schemas, by id. Ids are looked up in a fixed list, so no caller-supplied path is read. */
export async function readPluginSchema(packageRoot: string, id: string): Promise<string> {
  const entry = PLUGIN_SCHEMAS.find((candidate) => candidate.id === id);
  if (entry === undefined) {
    throw new Error(`Unknown schema: ${id}. Available: ${PLUGIN_SCHEMAS.map((candidate) => candidate.id).join(", ")}`);
  }
  return readFile(join(packageRoot, entry.file), "utf8");
}

export function renderPluginManifest(manifest: PluginManifest): string {
  const lines = [`${manifest.name} ${manifest.version} · plugin protocol ${String(manifest.protocol)}`, manifest.description, "", "Commands:"];
  for (const command of manifest.commands) {
    const effects = command.effects.length === 0 ? "read-only" : command.effects.join(", ");
    lines.push(`- ${command.id}: ${command.title} [${effects}; cost ${command.cost}]`);
  }
  lines.push("", "Widgets:");
  for (const widget of manifest.widgets) lines.push(`- ${widget.id}: ${widget.title} (${widget.command}, refresh ≥ ${String(widget.refresh.minIntervalSeconds)}s)`);
  lines.push("", "Actions:");
  for (const action of manifest.actions) lines.push(`- ${action.id}: ${action.title}`);
  lines.push("", "Print it as JSON with `conclave plugin manifest --json`; print a schema with `conclave plugin schema <id>`.");
  return lines.join("\n");
}
