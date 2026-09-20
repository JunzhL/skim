# 90-second demo runbook

The claim: *watch a skill conflict change how agents behave, then undo the install and watch the original
behaviour return.* Every step below has an observable artefact — a Git commit, a configuration version, or an
intercepted command — so nothing rests on what an agent says about itself.

## Before the clock starts

```bash
pnpm install
pnpm exec playwright install chromium        # only needed for pnpm test:e2e
pnpm demo:setup -- ../skim-demo              # prints SKIM_REPO_PATH=...
```

Put that path in `.env.local`, then start the dashboard:

```bash
pnpm dev                                     # http://localhost:3000
```

The import in this runbook pulls **from a public GitHub repository**, so the demo machine needs network access
to `github.com`. Conflict analysis needs a key for whichever provider `CONFLICT_MODEL_PROVIDER` selects; see
[Rehearsing without a provider key](#rehearsing-without-a-provider-key).

Confirm before starting: the header shows **Managed repository connected** with a `config <sha>` pill, the
Skills panel shows **Package Manager Policy · Active**, and Transaction history says *No committed Skill
Manager transactions yet.* If it does not, see [Troubleshooting](#troubleshooting).

## The walkthrough

Target 90 seconds. The mechanical work takes about 10 seconds; the rest is narration.

### 1 · One active skill, two agents on one version (0:00–0:15)

Point at the three panels.

| Where | Expected state |
| --- | --- |
| Header | `Managed repository connected`, `config <sha>` |
| Skills | `Package Manager Policy` · **Active** · scope tag `dependency-management` |
| Reloadable demo agents | **Builder** and **Reviewer**, both **Current**, both `loaded <same sha>` |

> "Both agents read one committed configuration. Same version, same skills."

Click **Run** on both agents.

**Evidence:** each card prints `pnpm add zod` with `lockfile pnpm-lock.yaml` and `run config <sha>`. No
package manager actually runs — the call is intercepted in a throwaway workspace.

### 2 · Pick a skill from the store and read the conflict (0:15–0:40)

In the **Add a skill** panel, stay on the **Featured** tab and click **Preview** on the **NPM Workflow** card.

> "Every entry is pinned to an exact commit. Picking one is the same import as typing the commit by hand."

The card shows what is being installed before anything happens: the subdirectory, the short commit, the
detected license, and the scope tags. The **Browse a repository** tab lists the skills in any pinned commit if
you want to show the catalogue is not hard-coded, and **Manual** still takes a URL, commit, and subdirectory
directly.

The Review panel becomes **Incoming: NPM Workflow** with a conflict card:

- scenario, the provider label (`OpenAI · …` or `DeepSeek · …`), and a confidence percentage;
- two quoted citations side by side, each with its own file and line range:
  `npm-workflow · SKILL.md:16–16` — "use `npm install` and update `package-lock.json`"
  `package-manager-policy · SKILL.md:16–16` — "use `pnpm add` and keep `pnpm-lock.yaml` updated"

The scenario wording comes from the model, so it varies between runs and between providers. The citations do
not: every quote and line range is checked against the real files before the report is shown.

**Evidence:** the header still reads `base <sha>` — the preview changed nothing.

### 3 · Choose a resolution, with confirmation (0:40–0:55)

Pick **Activate incoming** ("Pause conflicting active skills"), review the unified diff, then click
**Review resolution** and **Confirm activate-incoming**.

> "The install and the pause of the old policy are one commit. The system never overwrites an active skill on
> a model's say-so."

**Evidence:** the diff shows both `agents.yaml` and the new `skills/npm-workflow/` files. Nothing is written
until **Confirm**.

### 4 · Commit lands, agents do not move (0:55–1:10)

| Where | Expected state |
| --- | --- |
| Skills | `NPM Workflow` **Active**, `Package Manager Policy` **Paused** |
| Header | new `config <sha2>` |
| Agents | both flip to **Stale**, still `loaded <sha1>` |

Click **Run** on Builder *before* reloading: it still prints `pnpm add zod`.

> "A commit does not reach a running agent. That is the point."

Now click **Reload** then **Run** on both.

**Evidence:** both cards print `npm install zod` with `lockfile package-lock.json` and `run config <sha2>`.
The behaviour changed because committed configuration changed.

### 5 · Undo and watch the behaviour return (1:10–1:30)

In **Transaction history**, click **Undo** on the `install` entry.

| Where | Expected state |
| --- | --- |
| Banner | `Undo committed at <sha3>. Reload agents to observe the restored configuration.` |
| Skills | `Package Manager Policy` **Active** again, `NPM Workflow` gone |
| History | a new `undo` entry — `recovers: tx-…`, `<sha2> → <sha3>`; the `install` entry now reads **Undone** |
| Agents | **Stale** again |

Click **Reload** then **Run** on both: back to `pnpm add zod` and `pnpm-lock.yaml`.

**Closing evidence** — in a terminal:

```bash
git -C ../skim-demo log --oneline
# 01c2908 skim: undo tx-2e4aced6-…
# 7fcb0f6 skim: install npm-workflow (activate-incoming)
# c915252 chore: initialize skim demo repository
```

Three commits, nothing rewritten. Undo is a new recovery commit, so the install stays in the audit trail.

## Running it again

The runbook is repeatable against a fresh managed repository:

```bash
rm -rf ../skim-demo && pnpm demo:setup -- ../skim-demo
```

Restart `pnpm dev` so the agent sessions reload, and the same steps produce the same observable result. The
automated equivalent lives in `tests/integration/end-to-end.test.ts`, which asserts that two providers and a
repeated run produce byte-identical observable output.

## Rehearsing without a provider key

`pnpm test:e2e` drives this exact path against a mocked provider, so it is the safest rehearsal and needs no
API key. To rehearse the dashboard by hand without one, pick a store entry whose scopes do not
overlap anything installed — **Algorithmic Art** on the Featured tab is there for exactly this. No
overlap means no conflict analysis, so no adapter is constructed and no key is read. The conflict half of the
demo does need a working key for the selected provider.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Invalid runtime configuration: SKIM_REPO_PATH …` | Not set, not absolute, not a Git repository root, or it points inside this repository. Re-run `pnpm demo:setup` and copy the printed path. |
| `Another next dev server is already running` | A previous `next dev` survived. `pkill -f "next dev"`, then start again. |
| `spawn next ENOENT` | The wrapper was started with bare `node`. Use `pnpm dev` so `node_modules/.bin` is on `PATH`. |
| Preview fails with `INVALID_REQUEST` | Import URLs must be `https:`. A `file://` or `git@` URL is rejected at the API boundary. |
| Preview fails with `COMMIT_NOT_FOUND` | The commit is not reachable in that repository, or the machine is offline. |
| `MODEL_PROVIDER_CREDENTIALS_MISSING` | No key for the provider named by `CONFLICT_MODEL_PROVIDER`. The managed repository is never modified in this case. |
| Preview stops with `PREVIEW_NOT_FOUND` or a stale-base error | Previews are pinned to the base commit and expire. Generate a new one. |
| Undo shows a three-way diff instead of committing | A file the transaction touched changed afterwards. That is the safety check; resolve it by hand. |
| Agent still shows the old command | It has not been reloaded. `Reload` is deliberate; there is no hot reload. |
| `pnpm exec playwright install chromium` needed | Playwright's browser is not installed yet. Only `pnpm test:e2e` needs it. |
