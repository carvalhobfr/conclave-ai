# Conclave Crew (design)

Proposed by the owner on 2026-11-24, after looking at OpenBot (openbot.run). First version built on 2026-11-25 as `conclave-crew` 0.1.0 in [`packages/crew`](../packages/crew), not published yet; what it does and what was checked is under [Built](#built-010).

A queue of coding tasks, each worked by coding agents the person already uses (Claude Code and OpenCode write, Codex reviews), in short fixed-role rounds, in a separate Git worktree, with Conclave as the referee of every round and a person approving the end result. Inspired by OpenBot's agent teams, task queues and handoffs; built around the thing OpenBot leaves out, which is evidence and a human gate before anything lands.

## Why a separate package

Conclave is a read-only reviewer. [CONTRIBUTING.md](../CONTRIBUTING.md) rules out repository mutation, patch application, merge and autonomous task execution on its public surfaces, and the owner's standing rule for host apps is the same: use Conclave where it already helps, don't grow it for this. Crew needs agents that edit files, so it cannot live in `conclave-ai` without breaking that promise.

So Crew is its own package, **`conclave-crew`**, with its own `conclave-crew` command, its own version and its own plugin manifest. It calls Conclave through the CLI and its `--json` output, like any other host. Conclave stays exactly what it is; a person who only wants reviews never installs Crew.

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
5. **Referee.** Crew commits the round to the run's branch, runs the repository's test command if the person approved one, and attaches the result as a receipt, then `conclave check <worktree> --base <base> --objective … [--contract …] --previous-report <last round> --receipt <tests> --json`. Conclave treats a worktree as a mutable source, so a receipt bound only to the commit is `unbound`; Crew first runs one `conclave check` without a receipt to learn the change's `artifactDigest` and binds the receipt to it, which Conclave reports as `current`.
6. **Fix.** The driver gets the navigator's problems, Conclave's `handoff` text and the failing tests, and fixes. Back to 4.

The run stops when the navigator has nothing serious and Conclave passes; after the round limit (3 by default); when Conclave's lineage reports a duplicate rerun, stagnation or regression; when the run's time limit is spent (minutes; a token or cost budget is not in the first version, because the plans behind the CLIs don't report one); or on Stop. It then waits for the person with the final diff, the last Conclave report and the timeline.

**The end is always a person.** Crew never merges, never pushes, never opens a pull request. It leaves the branch and says how to bring it in (`git merge crew/<task-id>`); **Discard** removes the worktree and the branch after a confirmation.

## Safety

- **One worktree per run**, created by Crew at `.conclave/crew/runs/<run>/worktree` (ignored by Git, like the rest of `.conclave`), on its own branch. The agent CLI is started with that worktree as its working directory. Crew's commits there skip the repository's hooks (`core.hooksPath=/dev/null`, `--no-verify`) and signing, so no repository code runs and no key is asked for.
- **Each CLI in its most restrictive mode that still edits files**, set by Crew, never by the agent, and pinned by tests:
  - Claude Code: `--tools Read,Edit,Write,Glob,Grep` (no Bash, no web) with `--permission-mode acceptEdits` to write, `--tools Read,Glob,Grep` with `dontAsk` to read, `--setting-sources ""` so a repository's `.claude` settings can't add hooks, no MCP servers, no slash commands, no saved session. Checked live with Claude Code 2.1.304: a file inside the worktree was written, a write outside it was denied, and a shell command was impossible.
  - Codex: its edit mode always lets it run commands inside its sandbox, which the first version doesn't allow, so Codex is refused as driver and runs only as navigator or planner, with `--sandbox read-only`.
  - OpenCode: two agents of Crew's own in an inline configuration, every permission denied except reading (and editing, for the driver); `--pure` leaves the person's plugins out. Not checked live yet: OpenCode's free tier refuses modified agents.
- **Commands are Crew's, not the agent's.** Tests and the build run with a fixed command line the person approved for that repository (saved once, shown at every Start), with no shell, in the worktree, with a time limit. The agent can't add commands.
- **No secret files in prompts.** The diff sent to the navigator leaves out files whose names look like secrets (`.env*`, keys, certificates, `*secret*`, `*credential*`). The agents can read the worktree, as the person's own agent could; Crew adds nothing they couldn't see. Prompts and replies are kept only under `.conclave/crew/runs/<run>/`.
- **Disclosure before the first call**, like Conclave's Smart and Deep modes: which CLIs and models, what each may do, the round and time limits, the test command, and that nothing is merged or pushed. Without a terminal to ask in, `run` refuses unless `--yes` says the person confirmed elsewhere.
- **Repository code runs only through the approved test command.** Conclave itself still runs none.

## Where it shows

- **Terminal:** `conclave-crew crew set`, `tests set`, `tasks add|list|remove`, `run <task>`, `status [<run>]`, `stop <run>`, `discard <run>`, each with `--json`.
- **Cockpit:** a **Crew** page beside Review: the queue, running and finished runs, each run's timeline (round, role, provider, cost, Conclave verdict), the final diff. The cockpit's **Findings inbox** and **Issue proposals** gain "Make a task".
- **Host apps:** `conclave-crew plugin manifest --json`, protocol 1 like Conclave's, offering widgets (runs waiting for approval, runs in progress) and actions (start a run, with the host's own confirmation; stop; open in the cockpit). A host draws them and runs only the commands the manifest lists, with no shell, as hosts already do for Conclave's manifest.

## Host apps

A host that had planned to run agent rounds itself (a desktop app's pair-programming feature, for instance) can become a Crew host instead: it shows Crew's widgets and actions, and a two-role crew (driver, navigator) is the pair-programming case. The host still never starts an agent on its own: Start is a person's press, confirmed by the host, and the host runs only the manifest's command. Without Crew installed, the host shows nothing new.

## Built (0.1.0)

`packages/crew`, the `conclave-crew` command and a small library (`startRun`, `discardRun`, the store, the adapters). Tasks, the crew and the approved test command are kept per repository in `.conclave/crew/`; each run keeps `run.json` (state, every step, a summary per round), each step's prompt and reply, the plan, the tests' output, the receipt and Conclave's report. `stop` leaves a flag the run checks every half second, ending the current agent or command; a run whose process died shows as interrupted and can be discarded. `plugin manifest` prints the host contract in the shape of Conclave's protocol 1, with two differences: effects say what a command changes (worktree and branch, agents, tests), and the start and discard actions require confirmation.

Checked on 2026-11-25:

- Tests (`npm run test:crew`, 21): the adapters' arguments and reply parsing for the three CLIs; the navigator's problems (anything without a file and line dropped); runs with a fake agent and referee in real temporary repositories: a pass in one round with the person's checkout untouched, the round limit, Conclave's stagnation stopping the loop, no changes, Stop, an agent failure, test failures handed to the driver with the receipt bound to the probe's artifact, discard; and one run refereed by the real Conclave build, whose receipt comes back `current`.
- A real run in a throwaway repository with Claude Code (haiku) as driver and navigator, the real Conclave 0.25 and `node test.mjs` approved: plan, critique, build, commit, review, tests (exit 0), Conclave `pass` with the receipt `current`, in one round; the agent added `sub` to `math.js` and a check to `test.mjs`; the person's `main` stayed clean; `discard` removed the worktree and the branch.

Not built yet: the cockpit's Crew page and "Make a task" from findings, backup providers, the scheduled audit, publishing to npm (needs its own tag and workflow), and a live OpenCode or Codex run.

## Decisions (owner, 2026-11-25)

1. **Package:** separate, `conclave-crew`. Conclave stays read-only and CONTRIBUTING.md is unchanged.
2. **Repository:** this one, as an npm workspace beside `conclave-ai`, sharing its CI and release. Crew calls Conclave through its CLI, so it imports no code from it.
3. **Commands for agents:** none. Agents only edit files; Crew runs the approved test command.
4. **Name:** Crew.
