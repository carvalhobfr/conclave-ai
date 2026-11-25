import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { runProcess } from "./process.js";
import type { ApprovedTests } from "./types.js";

/** How Conclave is started: `conclave` on the PATH by default, or a program and leading arguments. */
export interface ConclaveCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export const DEFAULT_CONCLAVE: ConclaveCommand = { command: "conclave", args: [] };

const CHECK_TIMEOUT_MS = 180_000;

export interface CheckRequest {
  readonly worktree: string;
  readonly base: string;
  readonly objective: string;
  readonly contract?: string;
  readonly previousReport?: string;
  readonly receipt?: string;
  /** Where the JSON is saved. */
  readonly output: string;
  readonly shouldCancel?: () => boolean;
}

export interface CheckOutcome {
  readonly verdict: string;
  readonly progress: string;
  readonly artifactDigest: string;
  readonly needsWork: boolean;
  readonly handoff: string;
  readonly summary: string;
  readonly receiptStatus?: string;
}

export class RefereeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefereeError";
  }
}

/** Runs the referee: Conclave sees the worktree against the base. Its 1 (block) and 2 (inconclusive) are results. */
export type Referee = (request: CheckRequest) => Promise<CheckOutcome>;

export function conclaveReferee(conclave: ConclaveCommand = DEFAULT_CONCLAVE): Referee {
  return async (request) => {
    const args = [...conclave.args, "check", request.worktree, "--base", request.base, "--objective", request.objective];
    if (request.contract !== undefined) args.push("--contract", request.contract);
    if (request.previousReport !== undefined) args.push("--previous-report", request.previousReport);
    if (request.receipt !== undefined) args.push("--receipt", request.receipt);
    args.push("--json");
    const result = await runProcess(conclave.command, args, {
      cwd: request.worktree,
      timeoutMs: CHECK_TIMEOUT_MS,
      ...(request.shouldCancel === undefined ? {} : { shouldCancel: request.shouldCancel }),
    });
    if (result.cancelled) throw new RefereeError("stopped");
    if (result.exitCode === null || result.exitCode > 2) {
      const detail = result.stderr.trim().split("\n").slice(-3).join(" ") || (result.timedOut ? "timed out" : "no output");
      throw new RefereeError(`conclave check failed: ${detail}`);
    }
    await writeFile(request.output, result.stdout, "utf8");
    return parseCheck(result.stdout);
  };
}

export function parseCheck(stdout: string): CheckOutcome {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    throw new RefereeError("conclave check did not print JSON");
  }
  const report = record(payload["report"]);
  const lineage = record(report["lineage"]);
  const lifecycle = record(report["findingLifecycle"]);
  const handoff = record(payload["handoff"]);
  const receipts = record(report["receipts"])["items"];
  const verdict = report["verdict"];
  const artifactDigest = lineage["artifactDigest"];
  if (typeof verdict !== "string" || typeof artifactDigest !== "string") {
    throw new RefereeError("conclave check printed a report Crew can't read");
  }
  const receiptStatus = Array.isArray(receipts) ? record(receipts[0])["status"] : undefined;
  return {
    verdict,
    progress: typeof lifecycle["progress"] === "string" ? lifecycle["progress"] : "initial",
    artifactDigest,
    needsWork: handoff["needsWork"] !== false,
    handoff: typeof handoff["prompt"] === "string" ? handoff["prompt"] : "",
    summary: typeof payload["summary"] === "string" ? payload["summary"] : "",
    ...(typeof receiptStatus === "string" ? { receiptStatus } : {}),
  };
}

export interface TestsOutcome {
  readonly exitCode: number;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly output: string;
  readonly startedAt: string;
  readonly finishedAt: string;
}

/** Runs the approved test command in the worktree, without a shell. */
export async function runApprovedTests(tests: ApprovedTests, worktree: string, shouldCancel?: () => boolean): Promise<TestsOutcome> {
  const [command, ...args] = tests.argv;
  if (command === undefined) throw new Error("The approved test command is empty");
  const startedAt = new Date().toISOString();
  const result = await runProcess(command, args, {
    cwd: worktree,
    timeoutMs: tests.timeoutSeconds * 1_000,
    ...(shouldCancel === undefined ? {} : { shouldCancel }),
  });
  return {
    exitCode: result.exitCode ?? (result.timedOut ? 124 : 1),
    timedOut: result.timedOut,
    cancelled: result.cancelled,
    output: `${result.stdout}${result.stderr === "" ? "" : `\n${result.stderr}`}`,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}

/** A receipt bound to the artifact Conclave reviews, so it counts as current evidence for that exact change. */
export function testsReceipt(tests: ApprovedTests, outcome: TestsOutcome, artifactDigest: string): string {
  const lastLine = outcome.output.trim().split("\n").at(-1) ?? "";
  return JSON.stringify({
    version: 1,
    receipts: [{
      id: "crew-tests",
      type: "test",
      command: tests.argv.join(" "),
      exitCode: outcome.exitCode,
      startedAt: outcome.startedAt,
      finishedAt: outcome.finishedAt,
      artifactDigest,
      outputDigest: createHash("sha256").update(outcome.output).digest("hex"),
      runner: "conclave-crew",
      trustLevel: "locally-observed",
      summary: (outcome.timedOut ? "timed out: " : "") + lastLine.slice(0, 200),
    }],
  }, null, 2);
}

/** The end of the tests' output, for the driver. */
export function testsTail(output: string, limit = 4_000): string {
  return output.length > limit ? output.slice(-limit) : output;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
