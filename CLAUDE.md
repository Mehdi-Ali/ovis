@AGENTS.md

## Local build rule (fork only)

Commit before building. `bun run build` stamps `dist/build.json` with HEAD, so a build made
before the commit carries the previous commit and the app shows "App updated" with a Reload
that never clears it. After committing, run `ovis-upgrade rebuild` (builds HEAD, restarts Ovis
only). Never run `bun run build` on uncommitted changes.
