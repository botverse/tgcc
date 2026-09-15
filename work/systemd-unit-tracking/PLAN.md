# systemd-unit-tracking

## Problem

The TGCC systemd user unit (`~/.config/systemd/user/tgcc.service`) was an untracked
standalone file on this host. Earlier on 2026-09-15 it crash-looped for most of a day
(`status=127`, missing `libllhttp.so.9.3`) because `ExecStart` pinned a Homebrew Cellar
path that a `brew upgrade` invalidated. The fix — pointing `ExecStart` at the stable
brew symlink instead — was applied directly to the live file and existed nowhere else.
If this host is lost or the file is edited again, that fix (or the reason for it) is
gone.

## Scope

- Bring the current, already-fixed unit content into the repo, byte-identical, at
  `systemd/tgcc.service`.
- Point the live unit at the tracked copy via symlink so future edits go through Git.
- Bootstrap the minimal workflow records (`BACKLOG.md`, `PROJECT_LOG.md`, `work/<id>/`,
  repo `CLAUDE.md` workflow mapping) that `~/.claude/WORKFLOW.md` expects, since none
  existed in this repo yet.

### Exclusions

- Not changing `ExecStart` or any other unit directive — the current content is correct
  and is tracked as-is.
- Not restarting the `tgcc` service. `ExecStart` is unchanged, so no restart is needed;
  a restart would kill in-flight agent processes.
- Not adding CI/lint checks for the unit file.

## Acceptance criteria

- `systemd/tgcc.service` in the repo is byte-identical to the pre-change live file.
- The unit file contains no secrets (verified by grep before it was ever staged).
- `~/.config/systemd/user/tgcc.service` is a symlink resolving into this repo.
- `systemctl --user cat tgcc` reflects the tracked file's content.
- `tgcc`'s `MainPID` and `NRestarts` are unchanged across the whole change (proving no
  restart occurred).
- Root `BACKLOG.md`, `PROJECT_LOG.md`, and repo `CLAUDE.md` workflow-mapping section
  exist, are minimal, and contain only true statements (no invented history).

## Owner

Feature owner and integration owner for this change: the implementing agent (this
session), per the team lead's assignment. No separate integration owner was named for
this repo before this PR, so this PR also claims and records that role in the repo
`CLAUDE.md` workflow mapping.

## Verification plan

- `diff`/`md5sum` the repo copy against the live file before symlinking.
- `grep` the live file for secret-shaped strings before it touches Git.
- Capture `MainPID`/`NRestarts`/`ActiveEnterTimestamp` before and after the symlink swap
  and `daemon-reload`.
- `readlink -f ~/.config/systemd/user/tgcc.service` resolves into the repo.
- `systemctl --user is-active tgcc` stays `active` throughout.
