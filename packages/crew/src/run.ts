import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type AgentReply, type AgentRunner, supports } from "./agents.js";
import { addWorktree, branchExists, commitAll, deleteBranch, diffAgainst, removeWorktree, resolveCommit } from "./git.js";
import {
  INSTRUCTIONS, buildPrompt, critiquePrompt, fixPrompt, parseProblems, planPrompt, reviewPrompt, revisePrompt,
} from "./prompts.js";
import { type CheckOutcome, type Referee, RefereeError, runApprovedTests, testsReceipt, testsTail } from "./referee.js";
import { type CrewStore, member } from "./store.js";
import type {
  AgentMode, Crew, CrewMember, NavigatorProblem, Role, RoundSummary, RunLimits, RunRecord, StepRecord, StopReason, Task,
} from "./types.js";

export interface RunDependencies {
  readonly store: CrewStore;
  readonly agent: AgentRunner;
  readonly referee: Referee;
  readonly now?: () => Date;
  /** Per agent turn. */
  readonly agentTimeoutMs?: number;
  /** Told about each finished step, for a live view. */
  readonly onStep?: (step: StepRecord, run: RunRecord) => void;
}

export interface StartRequest {
  readonly task: Task;
  readonly crew: Crew;
  readonly limits: RunLimits;
}

export class CrewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrewError";
  }
}

/** Checks a crew before anything starts: a driver and a navigator, each tool able to do its job. */
export function validateCrew(crew: Crew): void {
  const driver = member(crew, "driver");
  const navigator = member(crew, "navigator");
  if (driver === undefined) throw new CrewError("The crew needs a driver");
  if (navigator === undefined) throw new CrewError("The crew needs a navigator");
  if (!supports(driver.tool, "edit")) {
    throw new CrewError(`${driver.tool} can't be the driver: it can't edit files without being able to run commands`);
  }
}

const DEFAULT_AGENT_TIMEOUT_MS = 15 * 60_000;

/**
 * One run, from the worktree to the person's decision. Each round: the driver builds or fixes, Crew commits to
 * the run's branch, the navigator reviews the diff, the approved tests run, and Conclave referees the change
 * against the base with the previous round's report. It stops on a pass, a limit, Conclave's lineage saying the
 * loop is stuck, a failure, or Stop, and always ends waiting for the person: Crew never merges or pushes.
 */
export async function startRun(request: StartRequest, deps: RunDependencies): Promise<RunRecord> {
  validateCrew(request.crew);
  const store = deps.store;
  const task = request.task;
  const now = deps.now ?? (() => new Date());
  const agentTimeoutMs = deps.agentTimeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  await store.ensure();

  const baseRef = task.base ?? "HEAD";
  let baseCommit: string;
  try {
    baseCommit = await resolveCommit(store.repository, baseRef);
  } catch {
    throw new CrewError(`The base "${baseRef}" is not a commit in this repository`);
  }
  const id = store.newRunId();
  const branch = `crew/${task.id}-${id.slice(-6)}`;
  if (await branchExists(store.repository, branch)) throw new CrewError(`The branch ${branch} already exists`);
  const folder = store.runFolder(id);
  const worktree = join(folder, "worktree");
  const tests = await store.tests();
  const startedAt = now();
  const deadline = startedAt.getTime() + request.limits.minutes * 60_000;

  let run: RunRecord = {
    id, taskId: task.id, objective: task.objective, repository: store.repository, worktree, branch, base: baseCommit,
    crew: request.crew, limits: request.limits, ...(tests === undefined ? {} : { tests }),
    status: "running", pid: process.pid, startedAt: startedAt.toISOString(), steps: [], rounds: [],
  };
  await store.saveRun(run);
  await addWorktree(store.repository, worktree, branch, baseCommit);

  const stopped = (): boolean => store.stopRequested(id);
  const timeUp = (): boolean => now().getTime() >= deadline;
  const cancel = (): boolean => stopped() || timeUp();

  const record = async (step: StepRecord): Promise<void> => {
    run = { ...run, steps: [...run.steps, step] };
    await store.saveRun(run);
    deps.onStep?.(step, run);
  };
  const finish = async (reason: StopReason, detail?: string): Promise<RunRecord> => {
    const failed = reason === "agent-failed" || reason === "referee-failed";
    const { pid, ...rest } = run;
    void pid; // a finished run has no process
    run = {
      ...rest,
      status: failed && run.rounds.every((round) => round.commit === undefined) ? "failed" : "waiting-approval",
      stopReason: reason,
      ...(detail === undefined ? {} : { detail }),
      finishedAt: now().toISOString(),
    };
    await store.saveRun(run);
    return run;
  };
  const save = async (name: string, content: string): Promise<string> => {
    await writeFile(join(folder, name), content, "utf8");
    return name;
  };

  const ask = async (
    round: number, step: StepRecord["step"], role: Role, mode: AgentMode, instructions: string, prompt: string,
  ): Promise<AgentReply> => {
    const who = roleMember(request.crew, role);
    const began = now().toISOString();
    const promptFile = await save(`${String(round)}-${step}.prompt.txt`, `${instructions}\n\n---\n\n${prompt}`);
    const reply = await deps.agent({
      member: who, mode, instructions, prompt, worktree, timeoutMs: Math.max(1_000, Math.min(agentTimeoutMs, deadline - now().getTime())), shouldCancel: cancel,
    });
    const replyFile = await save(`${String(round)}-${step}.reply.txt`, reply.error === undefined ? reply.text : `${reply.text}\n\n[error] ${reply.error}`);
    await record({
      round, step, role, tool: who.tool, ...(who.model === undefined ? {} : { model: who.model }),
      startedAt: began, finishedAt: now().toISOString(), ok: reply.ok,
      ...(reply.error === undefined ? {} : { note: reply.error }), files: [promptFile, replyFile],
    });
    return reply;
  };
  const interrupted = (reply: AgentReply): StopReason | undefined => {
    if (stopped()) return "stopped";
    if (timeUp()) return "time-limit";
    return reply.ok ? undefined : "agent-failed";
  };

  // Plan: the planner (or the driver) plans, the navigator critiques, the driver revises once.
  const planner: Role = member(request.crew, "planner") === undefined ? "driver" : "planner";
  const draft = await ask(0, "plan", planner, "read", INSTRUCTIONS.plan, planPrompt(task));
  let reason = interrupted(draft);
  if (reason !== undefined) return finish(reason, draft.error);
  const critique = await ask(0, "critique", "navigator", "read", INSTRUCTIONS.critique, critiquePrompt(task, draft.text));
  reason = interrupted(critique);
  if (reason !== undefined) return finish(reason, critique.error);
  let plan = draft.text;
  if (critique.text.trim().toUpperCase() !== "OK") {
    const revised = await ask(0, "revise", "driver", "read", INSTRUCTIONS.revise, revisePrompt(task, draft.text, critique.text));
    reason = interrupted(revised);
    if (reason !== undefined) return finish(reason, revised.error);
    plan = revised.text;
  }
  await save("plan.txt", plan);

  let previousReport: string | undefined;
  let fixInput: { problems: NavigatorProblem[]; handoff?: string; testsFailure?: string } | undefined;

  for (let round = 1; round <= request.limits.rounds; round += 1) {
    // Build or fix.
    const work = fixInput === undefined
      ? await ask(round, "build", "driver", "edit", INSTRUCTIONS.build, buildPrompt(task, plan))
      : await ask(round, "fix", "driver", "edit", INSTRUCTIONS.fix, fixPrompt(task, {
        problems: fixInput.problems,
        ...(fixInput.handoff === undefined ? {} : { conclaveHandoff: fixInput.handoff }),
        ...(fixInput.testsFailure === undefined ? {} : { testsFailure: fixInput.testsFailure }),
      }));
    reason = interrupted(work);
    if (reason !== undefined) return finish(reason, work.error);

    const commitStarted = now().toISOString();
    const commit = await commitAll(worktree, `crew: round ${String(round)} for ${task.id}\n\n${task.objective}`);
    await record({
      round, step: "commit", startedAt: commitStarted, finishedAt: now().toISOString(), ok: true,
      note: commit === undefined ? "no changes" : commit,
    });
    if (commit === undefined && round === 1) return finish("no-changes", "The driver changed nothing");

    // Navigator review of the whole change against the base.
    const diff = await diffAgainst(worktree, baseCommit);
    const review = await ask(round, "review", "navigator", "read", INSTRUCTIONS.review, reviewPrompt(task, diff));
    reason = interrupted(review);
    if (reason !== undefined) return finish(reason, review.error);
    const parsed = parseProblems(review.text);
    const problems = parsed.problems;
    const blocking = problems.filter((problem) => problem.severity === "blocking");

    // Referee: the approved tests (bound to the exact artifact) and Conclave.
    let outcome: CheckOutcome;
    let testsExitCode: number | undefined;
    let testsFailure: string | undefined;
    try {
      let receipt: string | undefined;
      if (tests !== undefined) {
        const probe = await deps.referee({
          worktree, base: baseCommit, objective: task.objective, ...(task.contract === undefined ? {} : { contract: task.contract }),
          output: join(folder, `${String(round)}-probe.json`), shouldCancel: cancel,
        });
        const testsStarted = now().toISOString();
        const result = await runApprovedTests(tests, worktree, cancel);
        if (result.cancelled) return await finish(stopped() ? "stopped" : "time-limit");
        testsExitCode = result.exitCode;
        const outputFile = await save(`${String(round)}-tests.txt`, result.output);
        receipt = join(folder, `${String(round)}-receipt.json`);
        await writeFile(receipt, testsReceipt(tests, result, probe.artifactDigest), "utf8");
        if (result.exitCode !== 0) testsFailure = testsTail(result.output);
        await record({
          round, step: "tests", startedAt: testsStarted, finishedAt: now().toISOString(), ok: result.exitCode === 0,
          note: result.timedOut ? "timed out" : `exit code ${String(result.exitCode)}`, files: [outputFile],
        });
      }
      const refereeStarted = now().toISOString();
      const reportFile = `${String(round)}-conclave.json`;
      outcome = await deps.referee({
        worktree, base: baseCommit, objective: task.objective,
        ...(task.contract === undefined ? {} : { contract: task.contract }),
        ...(previousReport === undefined ? {} : { previousReport }),
        ...(receipt === undefined ? {} : { receipt }),
        output: join(folder, reportFile), shouldCancel: cancel,
      });
      previousReport = join(folder, reportFile);
      await record({
        round, step: "referee", startedAt: refereeStarted, finishedAt: now().toISOString(), ok: true,
        note: `${outcome.verdict}, ${outcome.progress}${outcome.receiptStatus === undefined ? "" : `, receipt ${outcome.receiptStatus}`}`,
        files: [reportFile],
      });
    } catch (error) {
      if (stopped()) return finish("stopped");
      if (timeUp()) return finish("time-limit");
      if (error instanceof RefereeError) return finish("referee-failed", error.message);
      throw error;
    }

    const summary: RoundSummary = {
      round, ...(commit === undefined ? {} : { commit }), ...(testsExitCode === undefined ? {} : { testsExitCode }),
      verdict: outcome.verdict, progress: outcome.progress, needsWork: outcome.needsWork,
      blockingProblems: blocking.length, problems: problems.length,
    };
    run = { ...run, rounds: [...run.rounds, summary] };
    await store.saveRun(run);

    const testsPass = testsExitCode === undefined || testsExitCode === 0;
    if (!outcome.needsWork && blocking.length === 0 && testsPass) return finish("passed");
    if (round > 1 && (outcome.progress === "stagnant" || outcome.progress === "regression" || outcome.progress === "duplicate-recheck")) {
      return finish(outcome.progress, outcome.summary);
    }
    if (stopped()) return finish("stopped");
    if (timeUp()) return finish("time-limit");
    fixInput = {
      problems,
      ...(outcome.needsWork ? { handoff: outcome.handoff } : {}),
      ...(testsFailure === undefined ? {} : { testsFailure }),
    };
  }
  return finish("round-limit");
}

function roleMember(crew: Crew, role: Role): CrewMember {
  const found = member(crew, role);
  if (found === undefined) throw new CrewError(`The crew has no ${role}`);
  return found;
}

/** Removes a finished run's worktree and branch. The person confirmed before this is called. */
export async function discardRun(store: CrewStore, id: string): Promise<RunRecord> {
  const run = await store.run(id);
  if (run === undefined) throw new CrewError(`No run ${id}`);
  if (isRunning(run)) throw new CrewError("The run is still running: stop it first");
  if (run.status === "discarded") return run;
  try { await removeWorktree(store.repository, run.worktree); } catch { /* already gone */ }
  try { await deleteBranch(store.repository, run.branch); } catch { /* already gone */ }
  const discarded: RunRecord = { ...run, status: "discarded", finishedAt: run.finishedAt ?? new Date().toISOString() };
  await store.saveRun(discarded);
  return discarded;
}

/** Whether a run marked running still has its process. A run whose process died shows as interrupted. */
export function isRunning(run: RunRecord): boolean {
  if (run.status !== "running" || run.pid === undefined) return false;
  try {
    process.kill(run.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
