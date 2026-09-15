# Repo instructions for Claude/Codex

## Workflow mapping

Follow ~/.claude/WORKFLOW.md (global Claude/Codex PR workflow).

- Integration target: `origin/main` (github.com/botverse/tgcc, no branch protection configured as of 2026-09-15).
- Integration owner: whichever agent/session merges the PR; claim and record it per workstream — none is durably assigned repo-wide yet.
- Main backlog: BACKLOG.md.
- Captain's log: PROJECT_LOG.md.
- Feature plan/backlog/log: work/<id>/ (for pre-existing design work, see also specs/ and docs/, and the older .specs/ directory — map new work to those where it already fits instead of duplicating).
- Required checks and release procedure: no CI runs on pull requests today; `.github/workflows/publish.yml` only runs on `v*` tag pushes (`npm run build` then `npm publish`). Before merging, run the checks appropriate to what changed (`npm run build`, `npm test` for code changes) locally/manually.
- History/archive: no docs/history/ yet; create it if/when root records need grooming.

Feature agents own their branch records and propose root-record grooming in the PR. The integration owner reconciles and merges through the PR. Existing records are adopted incrementally; do not bulk-rewrite unverified history.
