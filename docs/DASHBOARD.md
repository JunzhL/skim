# Dashboard and skill library

The dashboard keeps repository state, the skill library, and preview operations distinct.
Repository and agent requests settle before the workspace skeleton disappears. Library errors
have their own retry action and do not hide a loaded workspace. Failed workspace loads can
be retried without a full reload. Requests time out after two minutes.

Featured skills support case-insensitive search over names, descriptions, tags, and source URLs.
Category and search filters combine; Clear filters restores the complete catalog. The 13 entries
in `fixtures/catalog.json` pin imports to full commit hashes. Newly added Anthropic entries were
verified against commit `34040c9c568585f6929bedeaad110ad08f079624`; document skills retain their
Proprietary license labels. Selecting Preview never installs a skill automatically.

Preview, install, and Undo share an in-flight guard. Confirmation controls are disabled while
committing, and failures release the guard. Motion respects the reduced-motion preference.

## Verification alongside development

An optional `SKIM_NEXT_DIST_DIR` isolates Next output from an existing development server:

```sh
SKIM_NEXT_DIST_DIR=.next/verification pnpm test:e2e
SKIM_NEXT_DIST_DIR=.next/production-check pnpm build
```

Next may add these temporary directories to `tsconfig.json` while generating route types.
The default remains `.next` when the variable is absent.

Desktop, 390px mobile, and loading screenshots are saved locally under `output/playwright/`.
