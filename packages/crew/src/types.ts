export type AgentTool = "claude" | "codex" | "opencode";
export const AGENT_TOOLS: readonly AgentTool[] = ["claude", "codex", "opencode"];

export type Role = "planner" | "driver" | "navigator";

/** `edit` may change files inside the worktree; `read` may only read them. Neither can run commands. */
export type AgentMode = "edit" | "read";

export interface CrewMember {
  readonly role: Role;
  readonly tool: AgentTool;
  readonly model?: string;
}

export interface Crew {
  readonly members: readonly CrewMember[];
}

export interface Task {
  readonly id: string;
  readonly objective: string;
  readonly criteria: readonly string[];
  /** Path to a Conclave contract, relative to the repository. */
  readonly contract?: string;
  /** Base ref the worktree starts from and Conclave compares against. */
  readonly base?: string;
  readonly createdAt: string;
}

/** The test command the person approved for this repository. Run without a shell, in the worktree. */
export interface ApprovedTests {
  readonly argv: readonly string[];
  readonly timeoutSeconds: number;
  readonly approvedAt: string;
}

export interface RunLimits {
  readonly rounds: number;
  readonly minutes: number;
}

export const DEFAULT_LIMITS: RunLimits = { rounds: 3, minutes: 30 };

export type RunStatus = "running" | "waiting-approval" | "failed" | "discarded";

export type StopReason =
  | "passed"
  | "round-limit"
  | "time-limit"
  | "stagnant"
  | "regression"
  | "duplicate-recheck"
  | "no-changes"
  | "stopped"
  | "agent-failed"
  | "referee-failed";

export type ProblemSeverity = "blocking" | "warning" | "info";

export interface NavigatorProblem {
  readonly severity: ProblemSeverity;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export interface StepRecord {
  readonly round: number;
  readonly step: "plan" | "critique" | "revise" | "build" | "fix" | "review" | "tests" | "referee" | "commit";
  readonly role?: Role;
  readonly tool?: AgentTool;
  readonly model?: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly ok: boolean;
  readonly note?: string;
  /** Files under the run folder that hold this step's prompt, output or report. */
  readonly files?: readonly string[];
}

export interface RoundSummary {
  readonly round: number;
  readonly commit?: string;
  readonly testsExitCode?: number;
  readonly verdict?: string;
  readonly progress?: string;
  readonly needsWork?: boolean;
  readonly blockingProblems: number;
  readonly problems: number;
}

export interface RunRecord {
  readonly id: string;
  readonly taskId: string;
  readonly objective: string;
  readonly repository: string;
  readonly worktree: string;
  readonly branch: string;
  readonly base: string;
  readonly crew: Crew;
  readonly limits: RunLimits;
  readonly tests?: ApprovedTests;
  readonly status: RunStatus;
  readonly stopReason?: StopReason;
  readonly detail?: string;
  readonly pid?: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly steps: readonly StepRecord[];
  readonly rounds: readonly RoundSummary[];
}
