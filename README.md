# skim

Skill Manager is a developer tool for managing shared agent skills with explicit configuration, provenance, and safe change history. Issue #2 establishes the TypeScript application foundation and contracts only; registry scanning, imports, conflict analysis, transactions, Undo, and agent execution are intentionally not implemented yet.

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

## Reserved API contracts

Issue #2 defines typed Zod request/response schemas without route handlers for:

- `GET /api/registry`
- `GET /api/transactions`
- `POST /api/imports/preview`
- `POST /api/transactions/install`
- `POST /api/transactions/:id/undo`
- `POST /api/agents/:id/reload`
- `POST /api/agents/:id/run`

All reserved endpoints share the `ApiError` schema.
