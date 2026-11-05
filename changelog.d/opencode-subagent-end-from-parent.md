### Fixed
- An OpenCode subagent now counts as running, and keeps its turn's BG wait, until the session that
  started it is told it ended, not as soon as the subagent goes idle while its own background work
  still runs.
