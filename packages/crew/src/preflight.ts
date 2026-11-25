import { runProcess } from "./process.js";
import type { ConclaveCommand } from "./referee.js";
import type { AgentTool, Crew } from "./types.js";

/** The oldest Conclave whose `check --json` carries what Crew reads (lineage, receipts, handoff). */
export const MINIMUM_CONCLAVE = "0.25.0";

const INSTALL: Readonly<Record<AgentTool, string>> = {
  claude: "Claude Code (claude) is not installed or not on the PATH",
  codex: "Codex (codex) is not installed or not on the PATH",
  opencode: "OpenCode (opencode) is not installed or not on the PATH",
};

export interface PreflightResult {
  readonly problems: readonly string[];
  readonly conclaveVersion?: string;
}

/** Version of a program, or undefined when it doesn't start. Runs nothing but `--version`. */
export type VersionProbe = (command: string, args: readonly string[]) => Promise<string | undefined>;

export const versionProbe: VersionProbe = async (command, args) => {
  const result = await runProcess(command, [...args, "--version"], { cwd: process.cwd(), timeoutMs: 20_000 });
  if (result.exitCode !== 0) return undefined;
  return /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] ?? result.stdout.trim();
};

/** Checks, before any agent is called, that Conclave and every CLI the crew needs are there. */
export async function preflight(crew: Crew, conclave: ConclaveCommand, probe: VersionProbe = versionProbe): Promise<PreflightResult> {
  const problems: string[] = [];
  const conclaveVersion = await probe(conclave.command, conclave.args);
  if (conclaveVersion === undefined) {
    problems.push("Conclave is not installed or not on the PATH: npm install -g conclave-ai (or pass --conclave <path>)");
  } else if (compare(conclaveVersion, MINIMUM_CONCLAVE) < 0) {
    problems.push(`Conclave ${conclaveVersion} is too old: Crew needs ${MINIMUM_CONCLAVE} or newer (npm install -g conclave-ai)`);
  }
  const tools = [...new Set(crew.members.map((item) => item.tool))];
  for (const tool of tools) {
    if (await probe(tool, []) === undefined) problems.push(INSTALL[tool]);
  }
  return { problems, ...(conclaveVersion === undefined ? {} : { conclaveVersion }) };
}

export function compare(left: string, right: string): number {
  const parts = (value: string): number[] => value.split(".").map((part) => Number.parseInt(part, 10) || 0);
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
