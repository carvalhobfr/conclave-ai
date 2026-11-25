#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { cliAgentRunner } from "./agents.js";
import { repositoryRoot } from "./git.js";
import { pluginManifest } from "./manifest.js";
import { preflight } from "./preflight.js";
import { type ConclaveCommand, DEFAULT_CONCLAVE, conclaveReferee } from "./referee.js";
import { CrewError, discardRun, isRunning, startRun, validateCrew } from "./run.js";
import { CrewStore, parseMember } from "./store.js";
import { type Crew, type CrewMember, DEFAULT_LIMITS, type RunRecord, type Task } from "./types.js";

const HELP = `Conclave Crew: coding agents in their own worktree, Conclave as referee, you approve.

Usage: conclave-crew <command> [options]   (--repo <path> picks the repository; --json for JSON)

  crew show                                   The crew of this repository
  crew set --driver <agent> --navigator <agent> [--planner <agent>]
                                              agent: claude, codex or opencode, optionally :model
                                              (codex only reviews: it can't edit without running commands)
  tests show | clear                          The approved test command
  tests set [--timeout <s>] -- <command…>     Approve the command Crew runs after each round (no shell)
  tasks list
  tasks add "<objective>" [--criterion "<text>"]… [--contract <file>] [--base <ref>]
  tasks remove <task>
  run <task> [--rounds <n>] [--minutes <n>] [--yes]
                                              Start a run; asks first unless --yes
  status [<run>]                              Runs, newest first, or one run's timeline
  stop <run>                                  Stop a running run
  discard <run> [--yes]                       Remove a run's worktree and branch; asks first unless --yes
  plugin manifest                             Commands, widgets and actions for host apps (JSON)

Crew never merges, pushes or opens a pull request. Design: docs/crew.md in the Conclave repository.`;

interface Parsed {
  readonly positionals: string[];
  readonly flags: Map<string, string[]>;
  readonly switches: Set<string>;
  readonly rest: string[];
}

const VALUE_FLAGS = new Set(["--repo", "--driver", "--navigator", "--planner", "--criterion", "--contract", "--base", "--rounds", "--minutes", "--timeout", "--conclave"]);

function parse(argv: readonly string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string[]>();
  const switches = new Set<string>();
  const dash = argv.indexOf("--");
  const head = dash === -1 ? argv : argv.slice(0, dash);
  const rest = dash === -1 ? [] : argv.slice(dash + 1);
  for (let index = 0; index < head.length; index += 1) {
    const item = head[index] ?? "";
    if (VALUE_FLAGS.has(item)) {
      const value = head[index + 1];
      if (value === undefined) throw new CrewError(`${item} needs a value`);
      flags.set(item, [...(flags.get(item) ?? []), value]);
      index += 1;
    } else if (item.startsWith("--")) {
      switches.add(item);
    } else {
      positionals.push(item);
    }
  }
  return { positionals, flags, switches, rest };
}

function one(parsed: Parsed, flag: string): string | undefined {
  return parsed.flags.get(flag)?.at(-1);
}

function integer(parsed: Parsed, flag: string, fallback: number, maximum: number): number {
  const raw = one(parsed, flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > maximum) throw new CrewError(`${flag} must be a whole number from 1 to ${String(maximum)}`);
  return value;
}

function version(): string {
  const file = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

function conclaveCommand(parsed: Parsed): ConclaveCommand {
  const path = one(parsed, "--conclave") ?? process.env["CONCLAVE_CREW_CONCLAVE"];
  if (path === undefined || path === "") return DEFAULT_CONCLAVE;
  return path.endsWith(".js") ? { command: process.execPath, args: [resolve(path)] } : { command: path, args: [] };
}

function memberLabel(item: CrewMember): string {
  return `${item.role}: ${item.tool}${item.model === undefined ? "" : ` (${item.model})`}`;
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) throw new CrewError("Confirmation needed: run it in a terminal, or add --yes after confirming");
  const reader = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^(y|yes|s|sim)$/i.test((await reader.question(`${question} [y/N] `)).trim());
  } finally {
    reader.close();
  }
}

function print(json: boolean, value: unknown, text: string): void {
  process.stdout.write(json ? `${JSON.stringify(value, null, 2)}\n` : `${text}\n`);
}

function runLine(run: RunRecord): string {
  const state = isRunning(run) ? "running" : run.status === "running" ? "interrupted" : run.status;
  const why = run.stopReason === undefined ? "" : ` (${run.stopReason})`;
  return `${run.id}  ${state}${why}  ${run.branch}  ${run.objective}`;
}

function timeline(run: RunRecord): string {
  const lines = [runLine(run), `worktree: ${run.worktree}`, `base: ${run.base.slice(0, 12)}`, ""];
  for (const step of run.steps) {
    const who = step.tool === undefined ? "crew" : `${step.role ?? ""} ${step.tool}`;
    lines.push(`round ${String(step.round)}  ${step.step.padEnd(8)} ${who.padEnd(20)} ${step.ok ? "ok" : "failed"}${step.note === undefined ? "" : `  ${step.note.split("\n")[0] ?? ""}`}`);
  }
  if (run.status === "waiting-approval") {
    lines.push("", `Waiting for you. Look at it:  git -C ${run.repository} diff ${run.base.slice(0, 12)} ${run.branch}`,
      `Bring it in:  git merge ${run.branch}     Throw it away:  conclave-crew discard ${run.id}`);
  }
  return lines.join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const parsed = parse(argv);
  const json = parsed.switches.has("--json");
  const [command, sub, third] = parsed.positionals;
  if (command === "version" || parsed.switches.has("--version")) {
    process.stdout.write(`${version()}\n`);
    return 0;
  }
  if (command === undefined || command === "help" || parsed.switches.has("--help")) {
    process.stdout.write(`${HELP}\n`);
    return 0;
  }
  if (command === "plugin" && sub === "manifest") {
    process.stdout.write(`${JSON.stringify(pluginManifest(version()), null, 2)}\n`);
    return 0;
  }

  const repository = await repositoryRoot(resolve(one(parsed, "--repo") ?? process.cwd())).catch(() => {
    throw new CrewError("Not inside a Git repository (use --repo <path>)");
  });
  const store = new CrewStore(repository);

  switch (command) {
    case "crew": {
      if (sub === "set") {
        const members: CrewMember[] = [];
        for (const role of ["planner", "driver", "navigator"] as const) {
          const value = one(parsed, `--${role}`);
          if (value !== undefined) members.push(parseMember(role, value));
        }
        const crew: Crew = { members };
        validateCrew(crew);
        await store.setCrew(crew);
        print(json, crew, `Crew saved: ${members.map(memberLabel).join(", ")}`);
        return 0;
      }
      const crew = await store.crew();
      print(json, crew ?? null, crew === undefined ? "No crew yet: conclave-crew crew set --driver claude --navigator claude" : crew.members.map(memberLabel).join("\n"));
      return 0;
    }
    case "tests": {
      if (sub === "set") {
        if (parsed.rest.length === 0) throw new CrewError("Give the command after --, for example: tests set -- npm test");
        const tests = { argv: parsed.rest, timeoutSeconds: integer(parsed, "--timeout", 600, 7_200), approvedAt: new Date().toISOString() };
        await store.setTests(tests);
        print(json, tests, `Approved: ${tests.argv.join(" ")} (at most ${String(tests.timeoutSeconds)} s, no shell)`);
        return 0;
      }
      if (sub === "clear") {
        await store.setTests(undefined);
        print(json, null, "No test command: Conclave referees without test evidence");
        return 0;
      }
      const tests = await store.tests();
      print(json, tests ?? null, tests === undefined ? "No test command approved" : `${tests.argv.join(" ")} (at most ${String(tests.timeoutSeconds)} s)`);
      return 0;
    }
    case "tasks": {
      if (sub === "add") {
        const objective = third?.trim() ?? "";
        if (objective === "") throw new CrewError('Give the objective: tasks add "Add passwordless login"');
        const contract = one(parsed, "--contract");
        const base = one(parsed, "--base");
        const task = await store.addTask({
          objective, criteria: parsed.flags.get("--criterion") ?? [],
          ...(contract === undefined ? {} : { contract }), ...(base === undefined ? {} : { base }),
        });
        print(json, task, `Added ${task.id}: ${task.objective}`);
        return 0;
      }
      if (sub === "remove") {
        if (third === undefined) throw new CrewError("Give the task id");
        const removed = await store.removeTask(third);
        print(json, { removed }, removed ? `Removed ${third}` : `No task ${third}`);
        return removed ? 0 : 1;
      }
      const tasks = await store.tasks();
      print(json, { tasks }, tasks.length === 0 ? "No tasks" : tasks.map((task: Task) => `${task.id}  ${task.objective}`).join("\n"));
      return 0;
    }
    case "run": {
      if (sub === undefined) throw new CrewError("Give the task id: run <task>");
      const task = await store.task(sub);
      if (task === undefined) throw new CrewError(`No task ${sub}`);
      const crew = await store.crew();
      if (crew === undefined) throw new CrewError("No crew yet: conclave-crew crew set --driver claude --navigator claude");
      validateCrew(crew);
      const limits = { rounds: integer(parsed, "--rounds", DEFAULT_LIMITS.rounds, 10), minutes: integer(parsed, "--minutes", DEFAULT_LIMITS.minutes, 480) };
      const conclave = conclaveCommand(parsed);
      const ready = await preflight(crew, conclave);
      if (ready.problems.length > 0) throw new CrewError(`Can't start yet:\n  ${ready.problems.join("\n  ")}`);
      const tests = await store.tests();
      const disclosure = [
        `Task: ${task.objective}`,
        ...crew.members.map((item) => `  ${memberLabel(item)}  (${item.role === "driver" ? "edits files in the worktree" : "reads only"}; runs no commands)`),
        `At most ${String(limits.rounds)} rounds and ${String(limits.minutes)} minutes. Each agent call uses your plan or key with that tool.`,
        tests === undefined ? "No test command approved: Conclave referees without test evidence." : `After each round Crew runs: ${tests.argv.join(" ")}`,
        `A new worktree and branch under .conclave/crew; your checkout is not touched. Nothing is merged or pushed.`,
      ].join("\n");
      if (!parsed.switches.has("--yes")) {
        process.stdout.write(`${disclosure}\n`);
        if (!(await confirm("Start?"))) return 1;
      }
      const run = await startRun({ task, crew, limits }, {
        store, agent: cliAgentRunner, referee: conclaveReferee(conclave),
        onStep: (step) => {
          if (!json) process.stderr.write(`round ${String(step.round)} ${step.step} ${step.ok ? "ok" : "failed"}${step.note === undefined ? "" : `: ${step.note.split("\n")[0] ?? ""}`}\n`);
        },
      });
      print(json, run, timeline(run));
      return run.status === "failed" ? 1 : 0;
    }
    case "status": {
      if (sub !== undefined) {
        const run = await store.run(sub);
        if (run === undefined) throw new CrewError(`No run ${sub}`);
        print(json, { ...run, running: isRunning(run) }, timeline(run));
        return 0;
      }
      const runs = await store.runs();
      print(json, { runs: runs.map((run) => ({ ...run, running: isRunning(run) })) }, runs.length === 0 ? "No runs" : runs.map(runLine).join("\n"));
      return 0;
    }
    case "stop": {
      if (sub === undefined) throw new CrewError("Give the run id");
      const run = await store.run(sub);
      if (run === undefined) throw new CrewError(`No run ${sub}`);
      if (!isRunning(run)) {
        print(json, { stopped: false }, "That run is not running");
        return 0;
      }
      await store.requestStop(sub);
      print(json, { stopped: true }, "Stop requested: the current step ends within a few seconds");
      return 0;
    }
    case "discard": {
      if (sub === undefined) throw new CrewError("Give the run id");
      const run = await store.run(sub);
      if (run === undefined) throw new CrewError(`No run ${sub}`);
      if (!parsed.switches.has("--yes") && !(await confirm(`Remove the worktree and delete the branch ${run.branch}? Its commits are lost.`))) return 1;
      const discarded = await discardRun(store, sub);
      print(json, discarded, `Discarded ${discarded.id}: worktree removed, branch ${discarded.branch} deleted`);
      return 0;
    }
    default:
      throw new CrewError(`Unknown command "${command}" (conclave-crew help)`);
  }
}

main(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
}, (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`conclave-crew: ${message}\n`);
  process.exitCode = 2;
});

