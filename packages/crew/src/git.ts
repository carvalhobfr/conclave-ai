import { runProcess } from "./process.js";

/**
 * Every Git call Crew makes. Crew's own commits skip the repository's hooks and signing, so no code from
 * the repository runs and no key is asked for; nothing here pushes, merges or touches the person's checkout.
 */
const GIT_TIMEOUT_MS = 60_000;

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

/** Files whose names suggest secrets never reach an agent's prompt. */
export const SECRET_PATHSPECS: readonly string[] = [
  ":(exclude,glob)**/.env",
  ":(exclude,glob)**/.env.*",
  ":(exclude,glob)**/*.pem",
  ":(exclude,glob)**/*.key",
  ":(exclude,glob)**/*.p12",
  ":(exclude,glob)**/id_rsa*",
  ":(exclude,glob)**/id_ed25519*",
  ":(exclude,glob)**/*secret*",
  ":(exclude,glob)**/*credential*",
  ":(exclude,glob)**/.conclave/**",
];

export class GitError extends Error {
  constructor(message: string, readonly stderr: string) {
    super(message);
    this.name = "GitError";
  }
}

export async function git(cwd: string, args: readonly string[]): Promise<string> {
  const result = await runProcess("git", args, { cwd, env: GIT_ENV, timeoutMs: GIT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new GitError(`git ${args[0] ?? ""} failed${result.timedOut ? " (timed out)" : ""}`, result.stderr.trim());
  }
  return result.stdout;
}

export async function repositoryRoot(path: string): Promise<string> {
  return (await git(path, ["rev-parse", "--show-toplevel"])).trim();
}

export async function resolveCommit(repository: string, ref: string): Promise<string> {
  return (await git(repository, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
}

export async function currentBranch(repository: string): Promise<string> {
  return (await git(repository, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

export async function branchExists(repository: string, branch: string): Promise<boolean> {
  try {
    await git(repository, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

export async function addWorktree(repository: string, path: string, branch: string, baseCommit: string): Promise<void> {
  await git(repository, ["worktree", "add", "--quiet", "-b", branch, path, baseCommit]);
}

export async function removeWorktree(repository: string, path: string): Promise<void> {
  await git(repository, ["worktree", "remove", "--force", path]);
}

export async function deleteBranch(repository: string, branch: string): Promise<void> {
  await git(repository, ["branch", "-D", branch]);
}

/** Commits everything in the worktree to its own branch. Returns the new commit, or undefined when nothing changed. */
export async function commitAll(worktree: string, message: string): Promise<string | undefined> {
  await git(worktree, ["add", "--all", "--", ".", ":(exclude,glob)**/.conclave/**"]);
  const staged = await git(worktree, ["diff", "--cached", "--name-only"]);
  if (staged.trim() === "") return undefined;
  await git(worktree, [
    "-c", "core.hooksPath=/dev/null",
    "-c", "commit.gpgSign=false",
    "-c", "user.name=Conclave Crew",
    "-c", "user.email=crew@conclave.invalid",
    "commit", "--quiet", "--no-verify", "-m", message,
  ]);
  return (await git(worktree, ["rev-parse", "HEAD"])).trim();
}

/** The worktree's change against its base, as text for an agent, without files that look like secrets. */
export async function diffAgainst(worktree: string, baseCommit: string): Promise<string> {
  return git(worktree, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", baseCommit, "--", ".", ...SECRET_PATHSPECS]);
}

export async function changedFileCount(worktree: string, baseCommit: string): Promise<number> {
  const names = await git(worktree, ["diff", "--name-only", baseCommit]);
  return names.split("\n").filter((line) => line.trim() !== "").length;
}
