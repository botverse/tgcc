# systemd-unit-tracking — log

## 2026-09-15

**Context.** The `tgcc` systemd user unit crash-looped earlier today (2435 restarts,
`status=127`, missing `libllhttp.so.9.3`) because `ExecStart` pinned a version-specific
Homebrew Cellar `node` path that a `brew upgrade` had invalidated. The unit was fixed
directly on this host (`ExecStart=/home/linuxbrew/.linuxbrew/bin/node dist/cli.js run`,
using the stable brew symlink) but the fix only existed as an untracked file at
`~/.config/systemd/user/tgcc.service`.

**Secret scan.** Before touching Git, read the live 428-byte unit file and grepped it
(`token|secret|key|password|passwd|bot_?token|api[_-]?key|ghp_|sk-|AKIA`, case
insensitive) — no matches. Its three `Environment=` lines are `NODE_ENV=production`,
`HOME=/home/fonz`, `PATH=...` — nothing secret-shaped. Safe to commit as-is.

**Backup.** Copied the live file to
`~/.config/systemd/user/tgcc.service.bak.20260915-124637` before any further changes.

**Repo state at start.** `main` was clean at `daa004b`, up to date with `origin/main`.
No `BACKLOG.md`, `PROJECT_LOG.md`, `CLAUDE.md`, `work/`, or `systemd/` existed in the
repo. No branch protection on `main` (`gh api repos/botverse/tgcc/branches/main/protection`
→ 404 "Branch not protected"). The only GitHub Actions workflow
(`.github/workflows/publish.yml`) triggers on `v*` tags, not on PRs — no CI gate applies
to this PR.

**Content added.**
- `systemd/tgcc.service` — copied from the live file; `diff` and `md5sum` confirmed
  byte-identical (`8d4b2e89e6d873b4a4585390ebfa8559`) before it was ever edited.
- `systemd/README.md` — install steps, why it's tracked, and the two risks called out
  below.
- Root `BACKLOG.md`, `PROJECT_LOG.md` — bootstrapped per `~/.claude/WORKFLOW.md`,
  containing only this one workstream; no history invented.
- Repo `CLAUDE.md` — created, with the `## Workflow mapping` section from
  `~/.claude/WORKFLOW.md`'s template, populated with this repo's actual facts.

**Symlink swap and verification.**

| Check | Before | After |
|---|---|---|
| `MainPID` | 549257 | 549257 (unchanged) |
| `NRestarts` | 2435 | 2435 (unchanged) |
| `ActiveEnterTimestamp` | 2026-09-15 12:40:24 BST | 2026-09-15 12:40:24 BST (unchanged) |
| `is-active` | active | active |

No restart occurred — confirmed by all three fields above being identical before and
after `rm` + `ln -s` + `systemctl --user daemon-reload`. `readlink -f
~/.config/systemd/user/tgcc.service` resolves to
`/home/fonz/Botverse/tgcc/systemd/tgcc.service`. `systemctl --user cat tgcc` shows the
symlink target's content, matching the tracked file.

**Risks recorded** (also in `systemd/README.md` and the PR description):
1. The live service now depends on this repo staying at `/home/fonz/Botverse/tgcc`.
   Moving/deleting the repo, or checking out a ref lacking `systemd/tgcc.service`,
   breaks the symlink.
2. Because the unit is now a tracked file, a future `git checkout`/`reset` can silently
   change what the live service runs on its next (re)start — there's no separate gate
   between "checkout" and "this is what production runs."

**Not tested / out of scope.** Did not test an actual service *restart* against the
symlinked unit (intentionally avoided — see Exclusions in PLAN.md); confidence that the
unit is valid rests on `daemon-reload` succeeding and `systemctl cat` rendering it
correctly, plus the fact that the content is byte-identical to what was already running.
