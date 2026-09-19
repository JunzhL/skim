---
name: package-manager-policy
description: Enforces pnpm for JavaScript dependency changes in the demo repository.
scopes:
  tasks: [dependency-management]
  fileGlobs: ["package.json", "pnpm-lock.yaml"]
workflows:
  - task: dependency-management
    executable: pnpm
    arguments: [add]
    lockfile: pnpm-lock.yaml
---

# Package Manager Policy

When adding a JavaScript dependency, use `pnpm add` and keep `pnpm-lock.yaml` updated.
