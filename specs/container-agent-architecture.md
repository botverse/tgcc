# Container Agent Architecture Spec

## Problem

Docker-mode agents (e.g. `kyo_team`) currently have no clear boundary between what runs inside the container vs what needs the host. Result: the agent uses `supervisor_exec` for everything — `ls`, `curl`, `npm run dev`, screenshot attempts — burning tokens and failing on tasks that need real host tooling (Patchright, dev servers, deployments).

## Architecture

```
┌─────────────────────────────────────────┐
│  Telegram Group ("KYO Team")            │
│  Members: Fnz, designers, devs          │
└────────────┬────────────────────────────┘
             │
     ┌───────▼───────┐
     │  kyo_team     │  Container agent (Docker)
     │  Thin sandbox │  Code-only: read, write, git, tests
     │               │  Delegates host tasks via tgcc_send
     └───────┬───────┘
             │ tgcc_send("kyobot", "run dev server and screenshot login page")
             │
     ┌───────▼───────┐
     │  kyobot       │  Host agent (local)
     │  Full env     │  Dev server, Patchright, DB, deploy
     │               │  Responds via tgcc_send back
     └───────────────┘
```

### Container agent (kyo_team) — thin sandbox
- **Image**: `node:20-slim` + git + build-essential (current `tgcc/sandbox`)
- **Can do**: Read/write/edit code, git operations (no push), run tests, npm install, linting
- **Cannot do**: Start dev servers (port not useful from inside), take screenshots, access host services, git push, deploy
- **Delegates to**: `kyobot` via `tgcc_send` for anything host-side

### Host agent (kyobot) — full environment
- **Runs on**: Host directly (no container)
- **Can do**: Run dev server, take screenshots (Patchright MCP), access Supabase, git push, deploy, systemctl
- **Tools**: All CC tools + Patchright MCP + full host access
- **Repo**: Same KYO repo (`/home/fonz/Botverse/KYO`)

## Changes Required

### 1. Add `claude_md` to kyo_team config
**File**: `~/.tgcc/config.json`

```json
{
  "kyo_team": {
    "share": {
      "mode": "docker",
      "claude_md": "For host operations (dev server, screenshots, browser testing, deployments, git push), use `tgcc_send` to message the `kyobot` agent. Do NOT use `supervisor_exec` for these — kyobot has full host access and proper tooling. Only use `supervisor_exec` for trivial one-liners like `git push`."
    }
  }
}
```

No code change — just config.

### 2. Add Patchright MCP to kyobot
**File**: `~/.tgcc/config.json`

kyobot needs the Patchright MCP server so it can take screenshots and interact with the browser. Two options:

**Option A — System-level MCP config** (in kyobot's CC project settings):
Add to `~/.claude/projects/-home-fonz-Botverse-KYO/settings.json`:
```json
{
  "mcpServers": {
    "patchright": {
      "command": "npx",
      "args": ["@anthropic-ai/patchright-mcp@latest"]
    }
  }
}
```

**Option B — TGCC-managed MCP config** (via `additionalServers` in MCP config generation):
Would need a new config field on non-docker agents. More complex, skip for now.

Recommendation: **Option A** — just add the MCP server to the project settings. kyobot is a local agent, CC picks up project-level MCP config automatically.

### 3. Thin the container image (optional, later)
Current image is 687MB with build-essential + python3. Could trim:
- Drop `build-essential` and `python3` if not needed (saves ~200MB)
- Use multi-stage build
- Pre-install CC to avoid npm install overhead

Not blocking — do this when the architecture is proven.

### 4. Kill supervisor_exec for container agents (optional, later)
Once `tgcc_send` delegation is proven, consider:
- Restricting `supervisor_exec` to only `git push/pull` for docker agents
- Or removing it entirely and routing all host commands through the host agent

Not blocking — the CLAUDE.md instructions should be sufficient for now.

## Inter-agent Communication Flow

### Screenshot request example:
```
User (group) → kyo_team: "Take a screenshot of the login page"
kyo_team → kyobot (via tgcc_send): "Take a screenshot of http://localhost:3002/login and send it to the user"
kyobot: uses Patchright MCP → browser_navigate → browser_take_screenshot → send_image
kyobot → kyo_team (via tgcc_send): "Screenshot sent to TG"
```

### Dev server debugging example:
```
User (group) → kyo_team: "The app is returning 500 errors"
kyo_team: checks code, finds nothing obvious
kyo_team → kyobot (via tgcc_send): "Check if the dev server is running, check logs for 500 errors"
kyobot: checks process, reads logs, reports findings
kyobot → kyo_team: "Server is running, 500 is from missing env var SUPABASE_URL in .env.local"
kyo_team: fixes the code/config
```

### Deployment example:
```
User (group) → kyo_team: "Deploy to staging"
kyo_team: commits changes, then:
kyo_team → kyobot (via tgcc_send): "Push main to origin and trigger staging deploy"
kyobot: git push, vercel deploy, reports status
```

## Implementation Order

1. **Config change** — add `claude_md` to kyo_team's share config (~1 min)
2. **Patchright for kyobot** — add MCP server to project settings (~2 min)
3. **Test** — new session for kyo_team, send it a task that needs host access, verify it delegates
4. **Iterate on CLAUDE.md** — tune based on agent behavior

## Open Questions

- **Should kyobot respond in the group or only via tgcc_send?** Currently kyobot has its own TG bot and only talks to allowedUsers in DM. For the delegation flow, it just needs to tgcc_send results back to kyo_team.
- **Port mapping**: kyo_team's container maps 3002→13002. But kyobot on the host accesses localhost:3002 directly (the real dev server). The container port mapping is only useful if something inside the container needs to serve HTTP.
- **Multiple docker agents sharing one host agent**: The pattern works for any docker agent — each just configures which host agent to delegate to via `claude_md`.
