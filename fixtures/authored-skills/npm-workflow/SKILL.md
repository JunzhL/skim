---
name: npm-workflow
description: Uses npm for JavaScript dependency changes in the demo repository.
scopes:
  tasks: [dependency-management]
  fileGlobs: ["package.json", "package-lock.json"]
workflows:
  - task: dependency-management
    executable: npm
    arguments: [install]
    lockfile: package-lock.json
---

# NPM Workflow

When adding a JavaScript dependency, use `npm install` and update `package-lock.json`.
