import type { NavigatorProblem, ProblemSeverity, Task } from "./types.js";

/** Fixed role instructions. The agents never choose their own role or tools. */
export const INSTRUCTIONS = {
  plan: [
    "You are the planner of a Conclave Crew run. Read the repository in the current folder and write a short plan",
    "(at most 10 numbered steps) for the objective you are given. Name the files you expect to change.",
    "Do not change any file. Reply with the plan only.",
  ].join(" "),
  critique: [
    "You are the navigator of a Conclave Crew run. Read the plan you are given against the repository in the current folder.",
    "List at most 5 concrete problems with it (a wrong file, a missed case, a risk). If it is sound, reply with OK alone.",
    "Do not change any file.",
  ].join(" "),
  revise: [
    "You are the driver of a Conclave Crew run. Revise your plan using the navigator's critique, keeping what was right.",
    "Reply with the final plan only. Do not change any file.",
  ].join(" "),
  build: [
    "You are the driver of a Conclave Crew run. Implement the plan in the current folder, editing files only inside it.",
    "You cannot run commands: Conclave Crew runs the tests and Conclave's review after you finish. Keep the change to",
    "what the objective needs. When done, reply with two or three sentences on what you changed.",
  ].join(" "),
  fix: [
    "You are the driver of a Conclave Crew run. Fix the problems you are given in the current folder, editing files only",
    "inside it. You cannot run commands. Fix what is real; when a problem is wrong, leave the code and say why.",
    "Reply with two or three sentences on what you changed.",
  ].join(" "),
  review: [
    "You are the navigator of a Conclave Crew run. Review the diff you are given against the objective; you may read the",
    "files in the current folder for context. Do not change any file. Reply with exactly one JSON object and nothing else:",
    "{\"problems\": [{\"severity\": \"blocking\" | \"warning\" | \"info\", \"file\": \"path/in/repo\", \"line\": 12, \"message\": \"...\"}]}.",
    "Blocking means the objective is not met or something breaks. Every problem needs a file and a line in the diff;",
    "a problem without them is discarded. Reply {\"problems\": []} when you find nothing.",
  ].join(" "),
} as const;

/** Characters of diff an agent gets at most; the rest is cut and the prompt says so. */
export const DIFF_LIMIT = 60_000;

export function taskBlock(task: Task): string {
  const lines = [`Objective: ${task.objective}`];
  if (task.criteria.length > 0) {
    lines.push("Acceptance criteria:", ...task.criteria.map((criterion) => `- ${criterion}`));
  }
  return lines.join("\n");
}

export function planPrompt(task: Task): string {
  return taskBlock(task);
}

export function critiquePrompt(task: Task, plan: string): string {
  return `${taskBlock(task)}\n\nPlan to critique:\n${plan}`;
}

export function revisePrompt(task: Task, plan: string, critique: string): string {
  return `${taskBlock(task)}\n\nYour plan:\n${plan}\n\nNavigator's critique:\n${critique}`;
}

export function buildPrompt(task: Task, plan: string): string {
  return `${taskBlock(task)}\n\nPlan:\n${plan}`;
}

export function reviewPrompt(task: Task, diff: string): string {
  const cut = diff.length > DIFF_LIMIT;
  const shown = cut ? diff.slice(0, DIFF_LIMIT) : diff;
  return `${taskBlock(task)}\n\nDiff against the base${cut ? ` (cut at ${String(DIFF_LIMIT)} characters; read the files for the rest)` : ""}:\n${shown}`;
}

export interface FixInput {
  readonly problems: readonly NavigatorProblem[];
  readonly conclaveHandoff?: string;
  readonly testsFailure?: string;
}

export function fixPrompt(task: Task, input: FixInput): string {
  const parts = [taskBlock(task)];
  if (input.problems.length > 0) {
    parts.push("Navigator's problems:\n" + input.problems
      .map((problem) => `- [${problem.severity}] ${problem.file}:${String(problem.line)}: ${problem.message}`)
      .join("\n"));
  }
  if (input.conclaveHandoff !== undefined && input.conclaveHandoff.trim() !== "") {
    parts.push(`Conclave's review:\n${input.conclaveHandoff.trim()}`);
  }
  if (input.testsFailure !== undefined) {
    parts.push(`The tests failed. End of their output:\n${input.testsFailure}`);
  }
  return parts.join("\n\n");
}

const SEVERITIES: readonly ProblemSeverity[] = ["blocking", "warning", "info"];

/**
 * The navigator's problems from its reply. Tolerates a code fence or text around the object; drops any
 * problem without a file and a positive line, so the navigator can't invent work.
 */
export function parseProblems(reply: string): { problems: NavigatorProblem[]; dropped: number; readable: boolean } {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start === -1 || end <= start) return { problems: [], dropped: 0, readable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return { problems: [], dropped: 0, readable: false };
  }
  const list = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>)["problems"] : undefined;
  if (!Array.isArray(list)) return { problems: [], dropped: 0, readable: false };
  const problems: NavigatorProblem[] = [];
  let dropped = 0;
  for (const item of list as unknown[]) {
    const record = typeof item === "object" && item !== null ? item as Record<string, unknown> : {};
    const file = record["file"];
    const line = record["line"];
    const message = record["message"];
    const severity = SEVERITIES.find((value) => value === record["severity"]) ?? "warning";
    if (typeof file !== "string" || file.trim() === "" || typeof line !== "number" || !Number.isInteger(line) || line < 1
      || typeof message !== "string" || message.trim() === "") {
      dropped += 1;
      continue;
    }
    problems.push({ severity, file: file.trim(), line, message: message.trim().slice(0, 2_000) });
  }
  return { problems, dropped, readable: true };
}
