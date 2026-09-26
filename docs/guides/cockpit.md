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
| Review the current change | **Review change** (1) |
| Copy the correction prompt for my agent | **Review change** → **Copy handoff prompt** (2) |
| See findings, the diff, or the raw report | **Review change** → tab (2) |
| Ask a question about the code | **Ask** → type → **Run ask** (2), or ⌘/Ctrl + Enter |
| Switch to another saved Conclave | Top-bar selector (1) |
| Continue a previous review series | **History** → **Continue this review** (2) |
| Add or change the API key | **Settings** → paste key → **Save and test** (2) |

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
