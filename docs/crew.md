# Conclave Crew (design)

Design note, not built. Proposed by the owner on 2026-11-24, after looking at OpenBot (openbot.run).

A queue of coding tasks, each worked by coding agents the person already uses (Claude Code, Codex, OpenCode), in short fixed-role rounds, in a separate Git worktree, with Conclave as the referee of every round and a person approving the end result. Inspired by OpenBot's agent teams, task queues and handoffs; built around the thing OpenBot leaves out, which is evidence and a human gate before anything lands.

## Why a separate package

Conclave is a read-only reviewer. [CONTRIBUTING.md](../CONTRIBUTING.md) rules out repository mutation, patch application, merge and autonomous task execution on its public surfaces, and the owner's standing rule for host apps is the same: use Conclave where it already helps, don't grow it for this. Crew needs agents that edit files, so it cannot live in `conclave-ai` without breaking that promise.

So Crew is its own package, **`conclave-crew`**, with its own `conclave-crew` command, its own version and its own plugin manifest. It calls Conclave through the CLI and its `--json` output, like any other host. Conclave stays exactly what it is; a person who only wants reviews never installs Crew. (Open question 1 below keeps the other option on the table.)

## What OpenBot does, and what Crew takes

OpenBot (desktop app, PolyForm Noncommercial 1.0.0, so ideas only, no code) runs agent CLIs as named teammates with a task queue each, hands work from one to another, offers scheduled workflows with an approval step, keeps per-agent memory, switches to a backup provider when a plan's limit is reached, and adds an embedded browser, computer use, phone apps, team servers and a plugin marketplace. Its README states that local agents run with full access and no per-action approval after a one-time consent.

| OpenBot idea | In Crew |
| --- | --- |
| Named agents with instructions | **Yes.** A crew is a few named roles (planner, driver, navigator), each tied to a CLI, a model and fixed instructions |
| Task queue | **Yes**, per repository: a task is an objective plus optional criteria, the same objective and contract `conclave check` already freezes |
| Agents handing work to each other | **Yes, as a fixed pipeline**: plan → build → review → referee → fix. No free chat between agents |
| Scheduled workflows with approval | **Partly.** A schedule may run what is deterministic (`conclave audit`) and turn findings into proposed tasks; starting an agent run always waits for a person in the first version |
| Backup provider when a plan runs out | **Yes**, only among the providers the person allowed for that run, and the timeline says when it switched |
| Memory per agent | **Per run, not per agent**: each run keeps its timeline, prompts, diffs and reports under `.conclave/crew/` |
| Full access, no approvals | **No.** See Safety |
| Browser, computer use, phone apps, team server, marketplace | **No.** Another product |

## A run

1. **Start.** The person picks a task and a crew and presses Start (or runs `conclave-crew run <task>`). Crew creates a worktree on a new branch `crew/<task-id>` from the chosen base. The person's checkout is never touched.
2. **Plan.** The planner (or the driver, in a two-role crew) writes a short plan; the navigator critiques it; one revision.
3. **Build.** The driver edits files in the worktree.
4. **Review.** The navigator reads the diff as text and answers with problems, each with a severity, a file and a line. A problem without a file and line is dropped.
5. **Referee.** Crew runs the repository's test command, if the person approved one for this repository, and attaches the result as a receipt, then `conclave check <worktree> --base <base> --objective … [--contract …] --previous-report <last round> --receipt <tests> --json`.
6. **Fix.** The driver gets the navigator's problems, Conclave's `handoff` text and the failing tests, and fixes. Back to 4.

The run stops when the navigator has nothing serious and Conclave passes; after the round limit (3 by default); when Conclave's lineage reports a duplicate rerun, stagnation or regression; when the run's budget (tokens, cost or minutes, whichever the person set) is spent; or on Stop. It then waits for the person with the final diff, the last Conclave report and the timeline.

**The end is always a person.** Crew never merges, never pushes, never opens a pull request. It leaves the branch and says how to bring it in (`git merge crew/<task-id>`); **Discard** removes the worktree and the branch after a confirmation.

## Safety

- **One worktree per run**, created by Crew, outside the person's checkout (`.conclave/crew/worktrees/<run>` or the system temp folder, to decide). The agent CLI is started with that worktree as its working directory.
- **Each CLI in its most restrictive mode that still edits files**, set by Crew, never by the agent: Claude Code with edit-only tools and no shell; Codex with its workspace-write sandbox and network off; OpenCode with shell and network denied in its permission config. The exact flags are checked against each CLI's current version before building and recorded in a test; a CLI that can't be restricted this way is refused, not run in full access.
- **Commands are Crew's, not the agent's.** Tests and the build run with a fixed command line the person approved for that repository (saved once, shown at every Start), with no shell, in the worktree, with a time limit. The agent can't add commands.
- **No keys in prompts or logs.** Diffs sent to the navigator go through Conclave's existing sanitizing (secret-looking lines masked, secret files left out); logs keep counts, not contents, except the run's own files under `.conclave/crew/`.
- **Disclosure before the first call**, like Conclave's Smart and Deep modes: which CLIs, which models, the round limit and the budget.
- **Repository code runs only through the approved test command.** Conclave itself still runs none.

## Where it shows

- **Terminal:** `conclave-crew tasks`, `conclave-crew run <task>`, `conclave-crew status`, `conclave-crew stop <run>`, `conclave-crew discard <run>`, each with `--json`.
- **Cockpit:** a **Crew** page beside Review: the queue, running and finished runs, each run's timeline (round, role, provider, cost, Conclave verdict), the final diff. The cockpit's **Findings inbox** and **Issue proposals** gain "Make a task".
- **Host apps:** `conclave-crew plugin manifest --json`, protocol 1 like Conclave's, offering widgets (runs waiting for approval, runs in progress) and actions (start a run, with the host's own confirmation; stop; open in the cockpit). A host draws them and runs only the commands the manifest lists, with no shell, as hosts already do for Conclave's manifest.

## Host apps

A host that had planned to run agent rounds itself (a desktop app's pair-programming feature, for instance) can become a Crew host instead: it shows Crew's widgets and actions, and a two-role crew (driver, navigator) is the pair-programming case. The host still never starts an agent on its own: Start is a person's press, confirmed by the host, and the host runs only the manifest's command. Without Crew installed, the host shows nothing new.

## First version

`conclave-crew` with: tasks per repository, two- or three-role crews over Claude Code, Codex and OpenCode, one worktree per run, round limit and budget, Conclave as referee with lineage stop conditions, approved test command as receipt, the run log under `.conclave/crew/`, the terminal commands and the plugin manifest. The cockpit page, findings → tasks, backup providers and the scheduled audit come after.

## Open questions for the owner

1. **Package:** a separate `conclave-crew` (recommended, keeps Conclave read-only), or Crew inside `conclave-ai` with the CONTRIBUTING rule rewritten?
2. **Repository:** a workspace inside this repository (shared release, shared sanitizing code), or a repository of its own?
3. **Commands for agents:** edit-only agents with Crew running the approved tests (recommended for the first version), or agents allowed to run commands inside their CLI's sandbox?
4. **Name:** Crew, or another?
