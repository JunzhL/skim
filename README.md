# skim

Skill Manager treats installing an agent skill as a reviewable Git transaction: import a skill pinned to one
commit, see the specific lines where it contradicts an active skill, choose a resolution, watch two agents
change behaviour, and undo the whole thing with a recovery commit that keeps the history.

The 90-second walkthrough, with the expected screen and the observable evidence at each step, is in
[`docs/RUNBOOK.md`](docs/RUNBOOK.md).

## Prerequisites

- Node.js `>=22.13 <23`
- Corepack
- Git

This repository pins `pnpm@12.4.0` through `packageManager`.

## Corepack and pnpm

Run the one-time Corepack setup if `pnpm` is not already available:

```bash
corepack enable
corepack prepare pnpm@12.4.0 --activate
pnpm --version
```

## Install

```bash
pnpm install
```

## Create the demo managed repository

The dashboard must manage a separate Git repository, never this application repository. Create one from the committed template:

```bash
pnpm demo:setup -- ../skim-demo
```

The command prints the absolute repository path and an `SKIM_REPO_PATH=...` line. It creates the repository atomically through a unique sibling temporary directory, initializes `main`, sets repository-local Git identity to `Skim Demo <demo@skim.local>`, and creates exactly one initial commit.

## Environment configuration

Copy the example file and fill it in:

```bash
cp .env.example .env.local
```

```dotenv
SKIM_REPO_PATH=/absolute/path/to/skim-demo
CONFLICT_MODEL_PROVIDER=openai
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-terra
DEEPSEEK_API_KEY=
DEEPSEEK_MODEL=deepseek-flash
```

- `SKIM_REPO_PATH` is required. It must be an absolute path to the root of an existing Git repository and must not be this application repository or a descendant of it.
- `CONFLICT_MODEL_PROVIDER` selects the conflict analyser, `openai` or `deepseek`. It defaults to `openai`.
- Only the selected provider's key is read. Both keys may be present at once; `CONFLICT_MODEL_PROVIDER` alone
  decides which one is invoked, and the other is never sent a request. Blank values are treated as unset, and a
  missing key for the selected provider fails with `MODEL_PROVIDER_CREDENTIALS_MISSING` at the point an
  analysis would run, without touching the managed repository. Imports whose scopes do not overlap never
  construct an adapter, so they still work without any key.
- Changing `CONFLICT_MODEL_PROVIDER` changes only the adapter used for analysis. Import, agent, transaction,
  dashboard, and Undo behaviour are unaffected, and the test suite asserts that.
- `OPENAI_MODEL` defaults to `gpt-5.6-terra` and `DEEPSEEK_MODEL` to `deepseek-flash`; blank values are rejected.
- Neither key is exposed to client code.

`pnpm dev` and `pnpm start` validate runtime configuration before launching Next.js. Because that check runs
before Next.js starts, the wrapper loads the same env files Next.js would, in the same order: for `pnpm dev`
`.env.development.local`, `.env.local`, `.env.development`, `.env`, and for `pnpm start` the `production`
equivalents. A variable that is already set in the real environment always wins, so a one-off run can override
the file:

```bash
SKIM_REPO_PATH=/absolute/path/to/other-repo pnpm dev
```

`pnpm build` intentionally does not depend on runtime environment values.

## Development

```bash
pnpm dev
```

Next.js runs with Turbopack in development. The shell page shows **Skill Manager** and confirms that the managed repository is connected after startup validation succeeds.

## Build and start

```bash
pnpm build
pnpm start
```

## Tests and checks

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:watch
pnpm test:e2e
pnpm test:all
```

Playwright uses Chromium. If the browser is not installed yet, install it once with:

```bash
pnpm exec playwright install chromium
```

**`pnpm test:all` is the one command that verifies the project.** It runs linting, type checking, the unit and
integration suites, the browser suite, and the production build in sequence.

The conflict-analysis contract is exercised through mocked OpenAI *and* mocked DeepSeek adapters, in the
integration suite and again in the browser suite, so CI never needs a provider key or provider network access.
Two checks are opt-in:

```bash
# Import the pinned anthropics/skills commit over the network and compare it to the vendored fixture hashes.
SKIM_NETWORK_TESTS=1 pnpm test

# Run one real analysis against a live provider. Use openai or deepseek.
SKIM_LIVE_PROVIDER=openai OPENAI_API_KEY=sk-... pnpm test
```

`tests/integration/end-to-end.test.ts` plays the documented runbook end to end and asserts that the two
providers, and a repeated run against a fresh managed repository, produce identical observable output: the
same cited conflict, the same install and recovery commits, and the same `pnpm add` → `npm install` →
`pnpm add` agent trace.

The browser suite imports the demo skill from `https://github.com/JunzhL/skim.git`, so it needs network access
to GitHub even though it never reaches a model provider.

## Pinned skill imports

A skill is imported as a complete directory from one exact revision. `importPinnedSkill` in
`src/lib/skills/import.ts` takes a Git URL, a full 40-character commit SHA, and a skill subdirectory, fetches
only that commit into a temporary bare repository, and copies the directory to `skills/<slug>/` in the managed
repository. `<slug>` is the `name` from the imported `SKILL.md` frontmatter.

Files are read straight from the Git object database and written by Skim, so nothing from the source repository
is ever checked out onto disk. Every file is staged in a temporary directory and moved into place with a single
rename, so a rejected import leaves the managed repository untouched.

Imports are rejected for:

| Error code | Cause |
| --- | --- |
| `INVALID_SOURCE` | Non-`https`/`file` URL, short or non-hex commit, absolute, traversing, or `.git` subdirectory |
| `COMMIT_NOT_FOUND` | The commit is not reachable in the source repository |
| `SUBDIRECTORY_NOT_FOUND` | The subdirectory does not exist at that commit |
| `UNSAFE_SYMLINK` | A symbolic link resolves outside the skill directory |
| `UNSUPPORTED_ENTRY` | A symbolic link, submodule, or other non-regular entry |
| `NESTED_GIT_DIRECTORY` | The skill directory contains a nested `.git` path |
| `SKILL_TOO_LARGE` | More than 500 files or 16 MiB |
| `MISSING_SKILL_FILE` | The directory has no `SKILL.md` |
| `INVALID_FRONTMATTER` | `SKILL.md` frontmatter is missing, malformed, or fails validation |
| `DESTINATION_EXISTS` | `skills/<slug>/` is already present, so a repeated import never overwrites it |

Because the commit is pinned, moving the source branch forward does not change imported content.

### `SKILL.md` frontmatter

```markdown
---
name: npm-workflow
description: Use npm for JavaScript dependency changes.
license: MIT
scopes:
  tasks: [dependency-management]
  fileGlobs: ["package.json"]
---
```

`name` and `description` are required. `license`, `scopes`, `dependencies`, and `workflows` are optional and
default to empty. Unknown keys are preserved by the parser and ignored. A license identifier detected from a
`LICENSE`, `COPYING`, or `NOTICE` file in the skill directory takes precedence over the declared `license`
value.

`scopes` narrows conflict analysis, `dependencies` lists other skill identifiers this skill needs, and
`workflows` declares the command a demo agent runs for a task:

```yaml
dependencies: [package-manager-policy]
workflows:
  - task: dependency-management
    executable: pnpm
    arguments: [add]
    lockfile: pnpm-lock.yaml
```

### Pinned no-conflict fixture

`fixtures/pinned-skills/algorithmic-art/` holds the complete `skills/algorithmic-art` directory from
`https://github.com/anthropics/skills` at commit `34040c9c568585f6929bedeaad110ad08f079624`, including its
Apache 2.0 `LICENSE.txt`. `fixtures/pinned-skills/algorithmic-art.source.json` records the source URL, commit,
subdirectory, detected license, and the expected SHA-256 hash of every file.

## Versioned registry

The managed repository HEAD is the shared configuration version. `readRegistry` in `src/lib/registry/` resolves
HEAD, reads the committed tree at that commit, and returns `configurationCommit`, skills, and agents. It never
reads the working tree, so two reads at the same HEAD return the same version and the same records, and
uncommitted edits stay invisible until they are committed.

Each skill record carries its source provenance (`git` with URL, commit, subdirectory, license and license
files, or `builtin`), the SHA-256 hash of every file in its directory, its declared scopes, and its enabled
state. A skill is enabled when at least one `agents.yaml` assignment enables it.

`.skim/registry.json` is the committed materialization of that snapshot and the provenance ledger: it is where
a skill's Git source survives across reads, since a copied directory cannot describe where it came from. Skill
records, hashes, and enabled state are always recomputed from the committed tree, so the file can never drift
from the files it describes.

## Demo agents

Two demo agents, `builder` and `reviewer`, come from `agents.yaml` in the managed repository. Each one loads a
registry snapshot and stays on that configuration version until it is explicitly reloaded, so a new commit
changes nothing until `reload()` runs. There is no hot reload.

An agent resolves its command from committed skill content, not from a table inside the application: among the
skills that are both enabled in the registry and enabled in that agent's assignments, exactly one may declare a
`workflows` entry for the task. Multiple active declarations are reported as
`AMBIGUOUS_PACKAGE_MANAGER_POLICY` regardless of assignment priority, and no declared workflow at all is
reported as `NO_PACKAGE_MANAGER_POLICY`. Importing a skill that declares its own workflow is therefore enough
to change agent behaviour.

Each run happens in a fresh temporary workspace seeded with a `package.json`, outside the managed repository.
The package-manager call is handed to an interceptor instead of being spawned, so nothing is downloaded or
installed: the interceptor records the command and writes the expected lockfile itself. Every run returns an
`AgentRun` with the agent ID, task, selected command, expected lockfile, configuration version, and timestamp.

With Package Manager Policy active, `add zod` resolves to `pnpm add zod` and `pnpm-lock.yaml`. With NPM
Workflow active, the same task resolves to `npm install zod` and `package-lock.json`.

## Deterministic validation and conflict candidates

`validateSkillSet` in `src/lib/validation/` runs the cheap structural checks that must pass before any model is
consulted. Blocking errors are `DUPLICATE_SKILL_ID`, `DUPLICATE_SKILL_NAME`, `DUPLICATE_SKILL_PATH`,
`DUPLICATE_FILE_DESTINATION`, `MISSING_DEPENDENCY`, `UNKNOWN_ASSIGNMENT`, and `INVALID_METADATA`. Errors and
candidates are sorted, so repeated runs on the same input produce byte-identical results.

Separately, it pairs skills whose declared scopes overlap into non-blocking conflict candidates. Task ids are
trimmed, lowercased, and deduplicated; file globs are normalised and compared by equality or by one pattern
matching the other as a literal path. Two globs that overlap only through wildcard intersection, such as
`a*.json` and `*b.json`, are not treated as overlapping.

`conflictAnalysisRequests` is the gate into semantic analysis: it returns nothing when any structural error is
present and nothing when no scopes overlap, so a model adapter is never reached in either case. The authored
pnpm and npm skills produce exactly one candidate over the shared `dependency-management` task, and the pinned
`algorithmic-art` fixture declares no scopes, so it never becomes a package-manager candidate.

## HTTP API

All endpoints share the `ApiError` schema and are validated with the Zod contracts in `src/lib/contracts/`.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/registry` | The registry at the managed repository HEAD |
| `GET /api/catalog` | The curated store front, pinned in `fixtures/catalog.json` |
| `POST /api/catalog/browse` | List every skill directory in one commit of any repository |
| `GET /api/transactions` | Committed install and Undo transactions |
| `POST /api/imports/preview` | Preview a pinned import, with conflict reports and the proposed diff |
| `POST /api/transactions/install` | Confirm a preview with `keep-existing`, `activate-incoming`, or `cancel` |
| `POST /api/transactions/:id/undo` | Create a recovery commit, or return a three-way diff when it is unsafe |
| `GET /api/agents/:id` | An agent's loaded configuration version and active skills |
| `POST /api/agents/:id/reload` | Load the current HEAD into that agent |
| `POST /api/agents/:id/run` | Run a dependency-addition task and return the `AgentRun` |

Import URLs must use `https:`. A `file://` or `git@` URL is rejected at the API boundary, even though the
importer library itself accepts `file://` for tests and local fixtures.

## Skill store

Skills reach the managed repository through one panel with three tabs.

**Featured** renders `fixtures/catalog.json`: a curated list where every entry carries a name, a description,
tags, a detected license, and a source pinned to an exact commit and subdirectory. Picking a card runs the same
preview as typing those fields by hand, so the demo never depends on pasting a 40-character SHA. A card whose
skill is already installed is disabled rather than silently re-importing.

**Browse a repository** takes any Git URL and commit and lists every directory containing a `SKILL.md` at that
commit, with its declared name, description, detected license, and file count. A directory whose frontmatter is
missing or malformed is skipped rather than failing the whole listing, so one broken skill cannot hide the
rest. The listing is sorted by path, so the same commit always produces the same order.

**Manual** is the original form: URL, commit, and subdirectory.

All three paths converge on `POST /api/imports/preview`, so they share one set of rules — HTTPS only, a full
40-character commit, and no change to the managed repository until confirmation.

## Scope

Delivered, and covered by `pnpm test:all`:

- A Next.js dashboard backed by an independent Git repository chosen with `SKIM_REPO_PATH`.
- Pinned, whole-directory skill imports with provenance, per-file SHA-256 hashes, and license detection.
- A skill store: a curated pinned catalogue plus live browsing of any repository at a chosen commit.
- A registry derived from the committed tree at HEAD, so every agent reads one configuration version.
- Deterministic structural validation, then scope-based conflict candidates, then an evidence-backed
  conflict report from OpenAI or DeepSeek with every citation verified against the real files.
- Atomic install transactions with a reviewable diff and an explicit confirmation step.
- Undo as a new recovery commit, with a three-way diff instead of a silent overwrite when an affected file
  changed.
- Two reloadable demo agents whose package-manager command comes from committed skill content and whose tool
  calls are intercepted rather than executed.

Deliberately not built:

- Cloud deployment, hosted persistence, and any Cloudflare or Huawei submission material.
- Adapters for third-party agent platforms, and general-purpose command execution.
- Automatic hot reload, unattended conflict resolution, and automatic rewriting of skill instructions.
- Local-directory, branch, and tag imports — a skill is always pinned to one commit.
- A searchable public skill marketplace. The store lists a curated file and browses one repository at a time;
  there is no index service, no cross-repository search, and no submission flow.
