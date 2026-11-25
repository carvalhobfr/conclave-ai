import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AGENT_TOOLS, type ApprovedTests, type Crew, type CrewMember, type Role, type RunRecord, type Task } from "./types.js";

/**
 * Everything Crew keeps for a repository lives in `<repository>/.conclave/crew/`, which Git ignores:
 * tasks.json, crew.json, tests.json, and runs/<id>/ with run.json, each step's prompt and output, and the
 * worktree itself (runs/<id>/worktree).
 */
export class CrewStore {
  readonly root: string;

  constructor(readonly repository: string) {
    this.root = join(repository, ".conclave", "crew");
  }

  async ensure(): Promise<void> {
    await mkdir(join(this.root, "runs"), { recursive: true });
    const ignore = join(this.repository, ".conclave", ".gitignore");
    if (!existsSync(ignore)) await writeFile(ignore, "# Created by Conclave Crew: local state, not meant for Git.\n*\n", "utf8");
    const own = join(this.root, ".gitignore");
    if (!existsSync(own)) await writeFile(own, "*\n", "utf8");
  }

  // Tasks

  async tasks(): Promise<Task[]> {
    return (await this.readJson<Task[]>("tasks.json")) ?? [];
  }

  async addTask(input: Omit<Task, "id" | "createdAt">): Promise<Task> {
    const tasks = await this.tasks();
    const task: Task = { id: newId("t"), createdAt: new Date().toISOString(), ...input };
    await this.writeJson("tasks.json", [...tasks, task]);
    return task;
  }

  async task(id: string): Promise<Task | undefined> {
    return (await this.tasks()).find((task) => task.id === id);
  }

  async removeTask(id: string): Promise<boolean> {
    const tasks = await this.tasks();
    const left = tasks.filter((task) => task.id !== id);
    if (left.length === tasks.length) return false;
    await this.writeJson("tasks.json", left);
    return true;
  }

  // Crew

  async crew(): Promise<Crew | undefined> {
    return this.readJson<Crew>("crew.json");
  }

  async setCrew(crew: Crew): Promise<void> {
    await this.writeJson("crew.json", crew);
  }

  // Approved tests

  async tests(): Promise<ApprovedTests | undefined> {
    return this.readJson<ApprovedTests>("tests.json");
  }

  async setTests(tests: ApprovedTests | undefined): Promise<void> {
    if (tests === undefined) {
      await rm(join(this.root, "tests.json"), { force: true });
      return;
    }
    await this.writeJson("tests.json", tests);
  }

  // Runs

  runFolder(id: string): string {
    if (!/^r-[a-z0-9-]+$/.test(id)) throw new Error(`Not a run id: ${id}`);
    return join(this.root, "runs", id);
  }

  newRunId(): string {
    return newId("r");
  }

  async run(id: string): Promise<RunRecord | undefined> {
    return this.readJson<RunRecord>(join("runs", id, "run.json"));
  }

  async saveRun(run: RunRecord): Promise<void> {
    await mkdir(this.runFolder(run.id), { recursive: true });
    await this.writeJson(join("runs", run.id, "run.json"), run);
  }

  async runs(): Promise<RunRecord[]> {
    const folder = join(this.root, "runs");
    if (!existsSync(folder)) return [];
    const ids = (await readdir(folder)).filter((name) => name.startsWith("r-"));
    const runs = await Promise.all(ids.map((id) => this.run(id)));
    return runs.filter((run): run is RunRecord => run !== undefined).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  stopFile(id: string): string {
    return join(this.runFolder(id), "stop");
  }

  async requestStop(id: string): Promise<void> {
    await writeFile(this.stopFile(id), new Date().toISOString(), "utf8");
  }

  stopRequested(id: string): boolean {
    return existsSync(this.stopFile(id));
  }

  // Files

  private async readJson<T>(relative: string): Promise<T | undefined> {
    try {
      return JSON.parse(await readFile(join(this.root, relative), "utf8")) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeJson(relative: string, value: unknown): Promise<void> {
    await this.ensure();
    const path = join(this.root, relative);
    const temporary = `${path}.${randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporary, path);
  }
}

function newId(prefix: string): string {
  const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  return `${prefix}-${stamp}-${randomBytes(3).toString("hex")}`;
}

/** Parses `claude`, `claude:opus` or `opencode:anthropic/claude-sonnet-4` into a crew member. */
export function parseMember(role: Role, value: string): CrewMember {
  const separator = value.indexOf(":");
  const tool = separator === -1 ? value : value.slice(0, separator);
  const model = separator === -1 ? "" : value.slice(separator + 1);
  const known = AGENT_TOOLS.find((item) => item === tool);
  if (known === undefined) throw new Error(`Unknown agent "${tool}": use ${AGENT_TOOLS.join(", ")}`);
  return model === "" ? { role, tool: known } : { role, tool: known, model };
}

export function member(crew: Crew, role: Role): CrewMember | undefined {
  return crew.members.find((item) => item.role === role);
}
