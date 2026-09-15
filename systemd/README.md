# systemd user unit

`tgcc.service` is the systemd user unit that runs TGCC as `systemctl --user` service `tgcc`.

## Install / link

The live unit at `~/.config/systemd/user/tgcc.service` is a symlink into this file:

```bash
ln -sf /home/fonz/Botverse/tgcc/systemd/tgcc.service ~/.config/systemd/user/tgcc.service
systemctl --user daemon-reload
systemctl --user enable --now tgcc
```

## Why this is tracked

On 2026-09-15 the unit's `ExecStart` pinned a Homebrew Cellar path (`/home/linuxbrew/.linuxbrew/Cellar/node/<version>/bin/node`) that a `brew upgrade` invalidated, crash-looping the service (`status=127`, missing `libllhttp.so.9.3`) for most of a day before anyone noticed. The fix — using the stable brew symlink (`/home/linuxbrew/.linuxbrew/bin/node`) instead of a version-pinned path — existed only as an untracked file on this one host. Tracking it here means the fix (and any future one) survives host loss and is reviewable like any other change.

## Risks

- **The live service now depends on this repo staying at `/home/fonz/Botverse/tgcc`.** Moving or deleting the repo, or checking out a branch/commit without `systemd/tgcc.service`, breaks the symlink and the service will fail to start on the next `daemon-reload`/restart.
- **A `git checkout` can now silently change the live service definition.** Switching branches, or resetting to an older commit that has a different `ExecStart`/`Environment`, changes what runs the next time the service (re)starts — there is no separate approval step between "checkout" and "this is what production runs."
- Do not put secrets (bot tokens, API keys) directly in this file — it's version controlled. Use `EnvironmentFile=` pointing at a path outside the repo (e.g. `~/.config/tgcc/tgcc.env`, not committed) if the unit ever needs one.
