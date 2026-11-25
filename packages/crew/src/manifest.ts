/**
 * What a host app may show and run, in the shape of Conclave's own plugin manifest (protocol 1). Unlike
 * Conclave's, two actions change things: starting a run (the agents edit files in a new worktree on a new
 * branch) and discarding one. Both are marked `confirmation: "required"`, and the host asks the person first.
 */
export const CREW_PLUGIN_PROTOCOL = 1;

export type CrewEffect = "writes-crew-state" | "creates-worktree-and-branch" | "runs-agents" | "runs-approved-tests" | "removes-worktree-and-branch";

export function pluginManifest(version: string): unknown {
  const repository = { name: "repository", type: "repository", description: "Repository folder", required: true, flag: "--repo" };
  const json = { name: "json", type: "switch", description: "JSON output", required: true, flag: "--json" };
  const command = (
    id: string, title: string, description: string, argv: string[], parameters: unknown[],
    effects: CrewEffect[], timeoutSeconds: number, longRunning = false,
  ): unknown => ({
    id, title, description, argv, parameters,
    output: { format: "json" }, resultExitCodes: {}, timeoutSeconds, cost: effects.includes("runs-agents") ? "high" : "low",
    effects, longRunning,
  });
  return {
    schemaVersion: 1,
    protocol: CREW_PLUGIN_PROTOCOL,
    id: "conclave-crew",
    name: "Conclave Crew",
    version,
    commands: [
      command("tasks", "Tasks", "The repository's task queue", ["tasks", "list"], [repository, json], [], 10),
      command("runs", "Runs", "Runs of the repository, newest first, with their state and rounds", ["status"], [repository, json], [], 10),
      command("run", "Start a run", "Agents work the task in a new worktree on a new branch; Conclave referees each round; ends waiting for the person",
        ["run"], [
          { name: "task", type: "text", description: "Task id", required: true },
          repository,
          { name: "yes", type: "switch", description: "The person confirmed in the host", required: true, flag: "--yes" },
          json,
        ], ["writes-crew-state", "creates-worktree-and-branch", "runs-agents", "runs-approved-tests"], 7_200, true),
      command("stop", "Stop a run", "Asks a running run to stop after killing its current step", ["stop"], [
        { name: "run", type: "text", description: "Run id", required: true }, repository, json,
      ], ["writes-crew-state"], 10),
      command("discard", "Discard a run", "Removes the run's worktree and branch", ["discard"], [
        { name: "run", type: "text", description: "Run id", required: true }, repository,
        { name: "yes", type: "switch", description: "The person confirmed in the host", required: true, flag: "--yes" }, json,
      ], ["writes-crew-state", "removes-worktree-and-branch"], 60),
    ],
    widgets: [
      {
        id: "crew-runs", title: "Crew runs", description: "Runs in progress and runs waiting for the person",
        command: "runs", arguments: { json: true }, sizes: ["medium", "large"], refresh: { minIntervalSeconds: 15 },
        fields: [
          { label: "Objective", path: "runs[].objective" },
          { label: "State", path: "runs[].status" },
          { label: "Why it stopped", path: "runs[].stopReason" },
          { label: "Branch", path: "runs[].branch" },
        ],
      },
    ],
    actions: [
      { id: "start-run", title: "Start Crew run…", description: "Run a task with the crew", command: "run", arguments: { yes: true, json: true }, binds: ["repository", "task"], confirmation: "required" },
      { id: "stop-run", title: "Stop run", description: "Stop a running run", command: "stop", arguments: { json: true }, binds: ["repository", "run"], confirmation: "none" },
      { id: "discard-run", title: "Discard run…", description: "Remove the run's worktree and branch", command: "discard", arguments: { yes: true, json: true }, binds: ["repository", "run"], confirmation: "required" },
    ],
  };
}
