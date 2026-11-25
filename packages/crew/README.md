# Conclave Crew

Coding agents work a task in their own Git worktree, in fixed-role rounds; [Conclave](https://github.com/carvalhobfr/conclave-ai) referees every round; you decide what lands.

```text
task → plan → build → commit → review → tests → Conclave check → fix … → waits for you
```

- **Agents only edit files**, inside the run's worktree, and run no commands. Claude Code and OpenCode can drive; Codex only reviews, because it can't edit without running commands.
- **Crew runs your tests**, with the command you approved, no shell, and gives Conclave the result as a receipt bound to the exact change.
- **It stops on its own**: Conclave and the navigator are satisfied, the round or time limit is reached, or Conclave's review lineage says the loop is stuck.
- **It never merges, pushes or opens a pull request.** The work waits on a branch `crew/…`; you merge it or discard it.

## Use

Needs Node 20+, Git, `conclave` on the PATH (`npm install -g conclave-ai`) and the agent CLIs you pick, signed in.

```bash
conclave-crew crew set --driver claude --navigator claude:opus
conclave-crew tests set -- npm test
conclave-crew tasks add "Add passwordless login without breaking session restore" --criterion "Existing sessions keep working"
conclave-crew tasks list
conclave-crew run <task>          # shows what will run and asks first
conclave-crew status <run>        # the timeline; how to look at, merge or discard the result
conclave-crew discard <run>
```

State lives in `.conclave/crew/` (ignored by Git). `conclave-crew plugin manifest` is the contract for host apps.

Design, safety model and what was checked: [docs/crew.md](https://github.com/carvalhobfr/conclave-ai/blob/master/docs/crew.md).
