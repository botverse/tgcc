# Project log

Bootstrapped 2026-09-15 alongside the first PR to use `~/.claude/WORKFLOW.md` in this
repo. This is a navigable captain's log going forward, not a reconstruction of the
project's history before this date — earlier work is not summarized here.

## 2026-09-15 — systemd unit brought under version control (proposal, pending merge)

The `tgcc` systemd user unit crash-looped 2435 times earlier today (`status=127`,
missing `libllhttp.so.9.3`) because `ExecStart` pinned a Homebrew Cellar path that a
`brew upgrade` invalidated. It was fixed on-host to use the stable brew symlink
(`/home/linuxbrew/.linuxbrew/bin/node`), but that fix existed only as an untracked file
— nowhere in Git. This change adds `systemd/tgcc.service` to the repo (content
unchanged from the fixed live file, verified byte-identical and free of secrets) and
points `~/.config/systemd/user/tgcc.service` at it via symlink, so future edits go
through Git and the fix isn't lost again. Verified no service restart occurred
(`MainPID`/`NRestarts`/`ActiveEnterTimestamp` unchanged across the change). Risk: the
live service now depends on this repo's checkout staying at
`/home/fonz/Botverse/tgcc` with `systemd/tgcc.service` present, and a future
`git checkout`/`reset` can change what the live service runs. Details:
`work/systemd-unit-tracking/LOG.md`. This entry describes branch verification; it will
be updated with the merge commit once integrated.
