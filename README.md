# skim

Skill Manager is a developer tool for managing shared agent skills with explicit configuration, provenance, and safe change history. Issues #2 and #3 establish the TypeScript application foundation, the typed contracts, pinned Git skill imports, and the versioned registry. Conflict analysis, install transactions, Undo, and agent execution are intentionally not implemented yet.

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

Copy the example file:

```bash
cp .env.example .env.local
```

Set:

```dotenv
SKIM_REPO_PATH=/absolute/path/to/skim-demo
OPENAI_API_KEY=
OPENAI_MODEL=gpt-5.6-terra
```

- `SKIM_REPO_PATH` is required. It must be an absolute path to the root of an existing Git repository and must not be this application repository or a descendant of it.
- `OPENAI_API_KEY` is optional for issue #2. Blank values are treated as unset. The application does not initialize the OpenAI SDK or expose this value to client code.
- `OPENAI_MODEL` defaults to `gpt-5.6-terra`; blank values are rejected.

`pnpm dev` and `pnpm start` validate runtime configuration before launching Next.js. `pnpm build` intentionally does not depend on runtime environment values.

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

`pnpm test:all` runs linting, type checking, Vitest, Playwright, and the production build in sequence.

Import tests run offline against locally built Git fixtures. One additional test imports the pinned
`anthropics/skills` commit over the network and checks it against the vendored fixture hashes. It is skipped
unless you opt in:

```bash
SKIM_NETWORK_TESTS=1 pnpm test
```

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

`name` and `description` are required. `license` and `scopes` are optional; scopes default to empty lists.
Unknown keys are preserved by the parser and ignored. A license identifier detected from a `LICENSE`,
`COPYING`, or `NOTICE` file in the skill directory takes precedence over the declared `license` value.

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

## Reserved API contracts

`GET /api/registry` is implemented and returns the registry at the managed repository HEAD.

Issue #2 defines typed Zod request/response schemas without route handlers for:

- `GET /api/transactions`
- `POST /api/imports/preview`
- `POST /api/transactions/install`
- `POST /api/transactions/:id/undo`
- `POST /api/agents/:id/reload`
- `POST /api/agents/:id/run`

All reserved endpoints share the `ApiError` schema.
