import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRequest, AgentRunner } from "../src/agents.js";
import { type CheckOutcome, type CheckRequest, type Referee, conclaveReferee } from "../src/referee.js";
import { CrewError, discardRun, startRun, validateCrew } from "../src/run.js";
import { CrewStore } from "../src/store.js";
import type { Crew, Task } from "../src/types.js";
import { git, temporaryRepository } from "./helpers.js";

const crew: Crew = { members: [{ role: "driver", tool: "claude" }, { role: "navigator", tool: "claude" }] };
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

function setup(): { repository: string; store: CrewStore } {
  const repository = temporaryRepository();
  cleanups.push(repository.cleanup);
  return { repository: repository.path, store: new CrewStore(repository.path) };
}

interface FakeAgentOptions {
  readonly reviews?: string[];
  readonly edits?: boolean;
  readonly onEdit?: (request: AgentRequest, count: number) => void;
}

/** Edits math.js in edit mode; answers plans, critiques and reviews in read mode. */
function fakeAgent(options: FakeAgentOptions = {}): { runner: AgentRunner; calls: AgentRequest[] } {
  const calls: AgentRequest[] = [];
  let edits = 0;
  let reviews = 0;
  const runner: AgentRunner = (request) => {
    calls.push(request);
    if (request.mode === "edit") {
      edits += 1;
      options.onEdit?.(request, edits);
      if (options.edits !== false) {
        writeFileSync(join(request.worktree, "math.js"), `export function add(a, b) {\n  return a + b;\n}\n// round ${String(edits)}\nexport function sub(a, b) {\n  return a - b;\n}\n`);
      }
      return Promise.resolve({ ok: true, text: "Added sub.", cancelled: false });
    }
    if (request.instructions.includes("Review the diff")) {
      const reply = options.reviews?.[reviews] ?? '{"problems": []}';
      reviews += 1;
      return Promise.resolve({ ok: true, text: reply, cancelled: false });
    }
    if (request.instructions.includes("critique") && !request.instructions.includes("Revise")) {
      return Promise.resolve({ ok: true, text: "OK", cancelled: false });
    }
    return Promise.resolve({ ok: true, text: "1. Add sub to math.js", cancelled: false });
  };
  return { runner, calls };
}

function fakeReferee(outcomes: Partial<CheckOutcome>[]): { referee: Referee; calls: CheckRequest[] } {
  const calls: CheckRequest[] = [];
  let index = 0;
  const referee: Referee = (request) => {
    calls.push(request);
    writeFileSync(request.output, "{}");
    const outcome = outcomes[Math.min(index, outcomes.length - 1)] ?? {};
    index += 1;
    return Promise.resolve({
      verdict: "pass", progress: "initial", artifactDigest: `artifact_${String(index)}`, needsWork: false, handoff: "", summary: "",
      ...outcome,
    });
  };
  return { referee, calls };
}

const task = (store: CrewStore, objective = "Add a sub function"): Promise<Task> => store.addTask({ objective, criteria: [] });

describe("crew validation", () => {
  it("needs a driver that can edit and a navigator", () => {
    expect(() => { validateCrew({ members: [{ role: "driver", tool: "claude" }] }); }).toThrow(/navigator/);
    expect(() => { validateCrew({ members: [{ role: "navigator", tool: "claude" }] }); }).toThrow(/driver/);
    expect(() => { validateCrew({ members: [{ role: "driver", tool: "codex" }, { role: "navigator", tool: "claude" }] }); }).toThrow(CrewError);
    expect(() => { validateCrew({ members: [{ role: "driver", tool: "opencode" }, { role: "navigator", tool: "codex" }] }); }).not.toThrow();
  });
});

describe("a run", () => {
  it("passes in one round and leaves the person's checkout alone", async () => {
    const { repository, store } = setup();
    const head = git(repository, "rev-parse", "HEAD").trim();
    const agent = fakeAgent();
    const referee = fakeReferee([{ verdict: "pass", needsWork: false }]);
    const run = await startRun({ task: await task(store), crew, limits: { rounds: 3, minutes: 5 } }, { store, agent: agent.runner, referee: referee.referee });

    expect(run.status).toBe("waiting-approval");
    expect(run.stopReason).toBe("passed");
    expect(run.pid).toBeUndefined();
    expect(run.rounds).toHaveLength(1);
    expect(git(repository, "rev-parse", "HEAD").trim()).toBe(head);
    expect(git(repository, "status", "--porcelain").trim()).toBe("");
    expect(readFileSync(join(repository, "math.js"), "utf8")).not.toContain("sub");
    expect(git(repository, "show", `${run.branch}:math.js`)).toContain("export function sub");
    expect(git(repository, "log", "-1", "--format=%an", run.branch).trim()).toBe("Conclave Crew");
    expect(agent.calls.find((call) => call.mode === "edit")?.worktree).toBe(run.worktree);
    expect(referee.calls[0]?.previousReport).toBeUndefined();
    expect(referee.calls[0]?.receipt).toBeUndefined();
    expect(existsSync(join(store.runFolder(run.id), "1-build.prompt.txt"))).toBe(true);
    expect((await store.run(run.id))?.stopReason).toBe("passed");
  });

  it("keeps going while Conclave or the navigator want work, then stops at the round limit", async () => {
    const { store } = setup();
    const agent = fakeAgent({ reviews: Array(3).fill(JSON.stringify({ problems: [{ severity: "blocking", file: "math.js", line: 5, message: "Missing test" }] })) as string[] });
    const referee = fakeReferee([{ verdict: "pass", needsWork: false, progress: "initial" }, { verdict: "pass", needsWork: false, progress: "progress" }]);
    const run = await startRun({ task: await task(store), crew, limits: { rounds: 3, minutes: 5 } }, { store, agent: agent.runner, referee: referee.referee });

    expect(run.stopReason).toBe("round-limit");
    expect(run.rounds.map((round) => round.blockingProblems)).toEqual([1, 1, 1]);
    expect(referee.calls[1]?.previousReport).toBe(join(store.runFolder(run.id), "1-conclave.json"));
    const fix = agent.calls.find((call) => call.instructions.includes("Fix the problems"));
    expect(fix?.prompt).toContain("[blocking] math.js:5: Missing test");
  });

  it("stops when Conclave's lineage says the loop is stuck", async () => {
    const { store } = setup();
    const agent = fakeAgent();
    const referee = fakeReferee([
      { verdict: "warn", needsWork: true, progress: "initial", handoff: "Add a test for sub" },
      { verdict: "warn", needsWork: true, progress: "stagnant", summary: "same findings" },
    ]);
    const run = await startRun({ task: await task(store), crew, limits: { rounds: 5, minutes: 5 } }, { store, agent: agent.runner, referee: referee.referee });

    expect(run.stopReason).toBe("stagnant");
    expect(run.rounds).toHaveLength(2);
    expect(agent.calls.find((call) => call.instructions.includes("Fix the problems"))?.prompt).toContain("Add a test for sub");
  });

  it("ends when the driver changes nothing", async () => {
    const { store } = setup();
    const run = await startRun({ task: await task(store), crew, limits: { rounds: 3, minutes: 5 } }, {
      store, agent: fakeAgent({ edits: false }).runner, referee: fakeReferee([{}]).referee,
    });
    expect(run.stopReason).toBe("no-changes");
    expect(run.rounds).toHaveLength(0);
  });

  it("stops when the person asks", async () => {
    const { store } = setup();
    const agent = fakeAgent();
    const run = await startRun({ task: await task(store), crew, limits: { rounds: 3, minutes: 5 } }, {
      store, agent: async (request) => {
        const reply = await agent.runner(request);
        if (request.mode === "edit") await store.requestStop(request.worktree.split("/").at(-2) ?? "");
        return reply;
      }, referee: fakeReferee([{}]).referee,
    });
    expect(run.stopReason).toBe("stopped");
  });

  it("records an agent failure", async () => {
    const { store } = setup();
    const run = await startRun({ task: await task(store), crew, limits: { rounds: 3, minutes: 5 } }, {
      store, agent: () => Promise.resolve({ ok: false, text: "", error: "usage limit reached", cancelled: false }), referee: fakeReferee([{}]).referee,
    });
    expect(run.status).toBe("failed");
    expect(run.stopReason).toBe("agent-failed");
    expect(run.detail).toBe("usage limit reached");
  });

  it("runs the approved tests, binds their receipt to the probe's artifact, and hands failures to the driver", async () => {
    const { store } = setup();
    await store.setTests({ argv: [process.execPath, "-e", "console.log('1 failing'); process.exit(1)"], timeoutSeconds: 30, approvedAt: "2026-11-25T00:00:00.000Z" });
    const agent = fakeAgent();
    const referee = fakeReferee([
      { artifactDigest: "artifact_probe1" }, { verdict: "pass", needsWork: false },
      { artifactDigest: "artifact_probe2" }, { verdict: "pass", needsWork: false, progress: "progress" },
    ]);
    const run = await startRun({ task: await task(store), crew, limits: { rounds: 2, minutes: 5 } }, { store, agent: agent.runner, referee: referee.referee });

    expect(run.stopReason).toBe("round-limit");
    expect(run.rounds.map((round) => round.testsExitCode)).toEqual([1, 1]);
    expect(referee.calls).toHaveLength(4);
    expect(referee.calls[0]?.receipt).toBeUndefined();
    const receipt = JSON.parse(readFileSync(referee.calls[1]?.receipt ?? "", "utf8")) as { receipts: { artifactDigest: string; exitCode: number }[] };
    expect(receipt.receipts[0]).toMatchObject({ artifactDigest: "artifact_probe1", exitCode: 1 });
    expect(agent.calls.find((call) => call.instructions.includes("Fix the problems"))?.prompt).toContain("1 failing");
  });

  it("discards a finished run's worktree and branch", async () => {
    const { repository, store } = setup();
    const run = await startRun({ task: await task(store), crew, limits: { rounds: 1, minutes: 5 } }, {
      store, agent: fakeAgent().runner, referee: fakeReferee([{}]).referee,
    });
    const discarded = await discardRun(store, run.id);
    expect(discarded.status).toBe("discarded");
    expect(existsSync(run.worktree)).toBe(false);
    expect(git(repository, "branch", "--list", run.branch).trim()).toBe("");
  });
});

const conclaveCli = resolve(import.meta.dirname, "../../../dist/cli.js");

describe.skipIf(!existsSync(conclaveCli))("a run refereed by the real Conclave", () => {
  it("gets a verdict and a current test receipt", async () => {
    const { store } = setup();
    await store.setTests({ argv: [process.execPath, "-e", "console.log('ok')"], timeoutSeconds: 30, approvedAt: "2026-11-25T00:00:00.000Z" });
    const run = await startRun({ task: await task(store, "Add a sub function to math.js"), crew, limits: { rounds: 1, minutes: 5 } }, {
      store, agent: fakeAgent().runner, referee: conclaveReferee({ command: process.execPath, args: [conclaveCli] }),
    });
    const referee = run.steps.find((step) => step.step === "referee");
    expect(referee?.ok).toBe(true);
    expect(referee?.note).toContain("receipt current");
    expect(["pass", "warn", "block", "inconclusive"]).toContain(run.rounds[0]?.verdict);
  }, 120_000);
});
