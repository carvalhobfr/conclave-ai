# Conclave cockpit

[English](cockpit.md) · [Português (Brasil)](cockpit.pt-BR.md) · [← README](../../README.md)

The cockpit is a local browser view of the same engine as the [CLI](cli.md). Use it when you'd rather read a review than scroll a terminal.

## Open it

```bash
conclave open .
```

Conclave starts a server on `127.0.0.1:4317`, opens your browser, and loads the repository. Options: `--port <n>` and `--no-browser`. Stop it with `Ctrl+C`.

The server only listens on loopback and only opens repositories under the folder you started it in. It cannot edit your code or apply a fix.

## Everything within three clicks

| I want to… | Clicks |
| --- | --- |
| See what is known about the repository | It opens on **Overview** (0) |
| Audit the whole repository with rules only | **Repository audits** → **Start Static audit** (2) |
| Triage a finding | **Findings inbox** → row → classification (3) |
| Review the current change | **Review** → **Review change** (2) |
| Copy the correction prompt for my agent | **Review** → **Review change** → **Copy handoff prompt** (3) |
| See findings, the diff, or the raw report | **Review** → **Review change** → tab (3) |
| Ask a question about the code | **Ask** → type → **Run ask** (2), or ⌘/Ctrl + Enter |
| Switch to another saved Conclave | Top-bar selector (1) |
| Continue a previous review series | **History** → **Continue this review** (2) |
| Add or change the API key | **Settings** → paste key → **Save and test** (2) |

## Where it opens

A repository opened by path (`conclave open .`, or **Open** in the sidebar) lands on **Overview**. The deterministic demo lands on **Review**. If you pick a screen while the repository is still opening, you stay on it. If the repository cannot be opened, the page says why and offers **Try again**.

The sidebar has three groups:

| Group | Screens |
| --- | --- |
| Repository | **Overview**, **Repository audits**, **Findings inbox**, **Issue proposals**, **Architecture** |
| Changes | **Review**, **Ask**, **Investigate**, **History**, **Commits** |
| Configuration | **Settings** |

The Repository screens need a local repository; the demo has no audit state. They read and write the same `.conclave` files as `conclave audit`, `conclave findings` and `conclave issues`.

## Overview

What is known about the repository as of the last audit: rule coverage and AI coverage as separate cards, findings by lifecycle, static findings by severity, AI hypotheses by verification outcome, and issue proposals waiting on a person. It never calls the repository verified: a file with no finding was not shown to be correct.

## Repository audits: Static, Smart and Deep

| Mode | What runs | Provider | Leaves the machine |
| --- | --- | --- | --- |
| **Static** | The deterministic rules | None | Nothing. No model call, no network request |
| **Smart** | Rules, then a model reads bounded regions and one verifier checks each hypothesis | The configured one | Sanitized source of the regions read, when the provider is remote |
| **Deep** | Rules, then discovery and the five reasoning roles on each hypothesis | The configured one | Same as Smart, with several times the calls |

**Static.** Choose **Static** → **Start Static audit**. There is no consent step because nothing is called.

**Smart and Deep.**

1. Choose the mode. The budget fields appear: **Max model calls** (default 40), **Max regions read** (30), **Hypotheses verified** (10), **Max minutes** (15), and optional **Discovery model** and **Verifier model** names (the verifier field applies to Smart). Empty fields use the defaults. Token limits use the CLI defaults (200,000 input, 40,000 output).
2. Read the disclosure. It names the provider host when source leaves the machine, the discovery and verifier models (and says when the verifier is the same model, which makes verification a second reading and not an independent check), the budget, that credential redaction is pattern based, that the provider may charge and Conclave cannot tell you the cost, and how many region results are cached.
3. Tick **I understand that this audit calls a model…**. The start button stays disabled until you do. Changing the mode, a budget field or a model name clears the tick, and so does starting an audit.
4. **Start Smart audit** / **Start Deep audit**. Progress lines appear while it runs. One audit runs per repository at a time.

If no provider is configured the page says so and the mode cannot start; **Settings** is where you add one. An audit that stops on a budget reports incomplete coverage and which limit ended it; running the same audit again continues with the regions it did not reach, and unchanged regions cost no call.

Below the controls: rule coverage, AI coverage, model usage against the budget, what the last audit does not establish, and the audit history.

## Findings inbox

One table for rule findings and model hypotheses, told apart by a labelled badge (**Static finding**, solid; **AI hypothesis**, dashed). Filter by search text, origin, verification outcome, lifecycle, classification and severity; sort by attention, severity, location or last seen.

Selecting a row opens its detail:

- **What is established** lists seven separate facts: static rule match, AI hypothesis, model support, model contradiction, reproduced defect, human confirmation, human issue approval. A model agreeing is shown as model support, never as confirmation, and "reproduced" is always no, because nothing is executed.
- For a hypothesis: trigger, consequence, the model's suggestion and stated confidence, the discovery and verifier models, the verifier's reasoning, supporting and contradictory evidence, unverified assumptions, and which lines the model actually read.
- A hypothesis whose trigger needs invalid input is **kept** when no call site passing it was found. Its detail says reachability is unproven and that it was not shown to be unreachable. A disputed or inconclusive hypothesis is also kept; it ranks lower.
- **Source references** shows the lines from disk. A path outside the repository, a credential file or a file matching a secret detector is withheld, with the reason.
- **Your classification**: **Confirm**, **Mark false positive**, **Accept risk** (these two need a note), **Needs investigation**, **Clear classification**. A classification is yours and is recorded locally; it approves nothing.
- **Create issue proposal** drafts a local proposal from the finding.

**Close** returns to the full table.

## Issue proposals

A proposal is a local draft. Nothing here publishes to GitHub, and no route exists that would.

1. Edit **Title**, **Body** and **Labels**, then **Save edits**. The body is Markdown source shown as plain text; it is never rendered. Saving changes the revision.
2. **Submit for review**.
3. Tick **I read the title, body and labels above at revision … and approve exactly that text**, then **Approve this revision**. The approval covers that revision only.
4. Or give a reason and **Reject proposal**.

An approval is void as soon as the text is edited, the finding is reclassified, or the source behind it changes. The proposal then shows **Stale** with the reason; **Refresh from the current finding** regenerates the text and returns it to draft for a new review. **Publication** lists what a future publisher would still require.

## Architecture

Files, symbols, modules, dependencies between modules and the most connected files, read from the index built when the repository was opened, plus what is not in the index and why. No model is involved, and a relation the parser could not resolve is absent. **Symbol explorer** looks one symbol up in the graph.

## Keyboard and small screens

- Every control is reachable with Tab and shows a focus outline. A row's title is the button that opens it; **Close** puts focus back on that row.
- The audit mode is one tab stop; the arrow keys move between Static, Smart and Deep. Moving to Smart or Deep still needs the tick.
- Status is always written out (**Model-supported**, **Stale**, **Persistent**); color and badge shape only repeat it.
- On a narrow window the sidebar moves above the page with its groups wrapped, the filters stack in two columns, and a detail opens below its table and scrolls into view. Wide tables scroll sideways inside their frame.
- Light and dark follow the system setting.

## Review

The review screen opens on the objective and a **Review change** button. Everything else lives under **Options**, whose summary line shows what will be compared:

- **Compare**: current workspace, committed branch, working tree, staged changes, or a commit;
- **Acceptance criteria**: saved objective and criteria for this repository;
- **Compare with saved review**: continue a series so the result shows progress since then;
- **Attach execution receipts**: a JSON file with test or build results;
- **Optional contract**: scope and completion claims in the same JSON the CLI accepts.

Results start with a decision summary: verdict, next action, what needs attention, and what still needs verification. Tabs hold **Findings**, **Claims**, **Impact**, **Diff**, **Agent handoff**, and **Raw report**.

## Ask and Investigate

These optional modes use your configured provider. **Ask** gives an evidence-backed answer; **Investigate** challenges hypotheses about a behavior. Results show verified claims, the evidence behind each one, the code graph, and why each piece of context was retrieved. If no provider is set, the page offers a **Set up a provider first** button.

## Settings and Conclaves

A **Conclave** is a saved review setup: provider, model, and reasoning depth. Built-in presets:

| Conclave | Cost | Use |
| --- | --- | --- |
| Essential | Low (≈ $0.0015 per review) | Recommended default |
| Free trial | Free while offered | Trying Conclave; the model may be withdrawn |

- Click a card or pick from the top bar to switch. When your saved key already belongs to that provider, it applies at once. Otherwise, Settings opens with the form filled, so only the key is missing.
- ☆ adds a favorite; **Make default** chooses the one that loads first; **Create your own** saves the current setup under a name.
- Below the cards you can set the provider, model (**Load available models** lists what your key can use), endpoint, reasoning depth, and API key. **Save and test** saves and sends one small test request.

The key goes over the loopback connection to the same settings file the CLI uses (`conclave config` shows it). The browser only ever receives a masked hint such as `op••••9x7z`.

## History

Every review from the cockpit or `conclave check` is listed here, newest first, and stays on your machine. **Continue this review** starts the next review in the same series.

## Commits

The latest commits of the repository, newest first, with author, date and size. **Review the latest 10 commits** runs the deterministic review on each one against its first parent, with the commit subject as the objective, and shows a verdict, finding counts and the top findings. It makes no model call and changes nothing in your checkout. The same data is available as `conclave commits . --json`.
