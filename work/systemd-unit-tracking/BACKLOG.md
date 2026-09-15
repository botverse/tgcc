# systemd-unit-tracking — feature backlog

## Done

- [x] Locate, back up, and secret-scan the live unit file.
- [x] Add `systemd/tgcc.service` (byte-identical to the live file) and
      `systemd/README.md` (install steps + why-tracked + risks).
- [x] Symlink `~/.config/systemd/user/tgcc.service` to the repo copy.
- [x] `daemon-reload` and verify no restart occurred.
- [x] Bootstrap root `BACKLOG.md`, `PROJECT_LOG.md`, and repo `CLAUDE.md` workflow
      mapping (none existed before this PR).

## Follow-ups (not in this PR's scope)

- No automated check currently catches unit-file drift between what's tracked and what
  a future manual edit does to the live symlink target — both are the same file by
  construction now, so this is low-risk, but worth noting if the repo ever grows a
  "verify deployed config matches repo" check.
- Consider moving other host-local, previously-untracked operational files (if any
  exist) into the repo under the same pattern, on request.
