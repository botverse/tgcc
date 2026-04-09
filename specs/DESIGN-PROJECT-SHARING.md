# Project Sharing via Isolated CC Instances

## Concept

Share a project with someone by giving them access to:
1. A **Telegram agent** (TGCC worker) scoped to the project
2. A **VS Code Remote** IDE connected to the project repo (via Tailscale SSH)
3. A **Tailscale hostname** for direct SSH access — no port forwarding or VPN

The shared CC instance runs **inside a Docker container** alongside the project. This gives CC full access to the project's runtime environment — system libraries, Python packages, CLI tools — while isolating it from the host.

## Key Design Decisions

### Session Isolation via `CLAUDE_CONFIG_DIR`

CC supports overriding its entire config directory via `CLAUDE_CONFIG_DIR`. Each shared agent gets its own config dir under `~/.tgcc/`, following the existing TGCC directory structure:

```
~/.tgcc/
├── config.json          # existing TGCC config
├── state.json           # existing TGCC state
└── agents/
    └── <agentId>/
        └── repos/
            └── <repo-slug>/
                └── .claude/
                    ├── projects/
                    │   └── <sanitized-project-path>/
                    │       ├── {sessionId}.jsonl
                    │       └── memory/
                    │           └── MEMORY.md
                    ├── settings.json
                    └── CLAUDE.md
```

`repo-slug` uses the same algorithm as `computeProjectSlug()` — replace `/` and `.` with `-`, truncate with hash suffix if > 50 chars. Example: `/home/fonz/Botverse/sentinella` → `-home-fonz-Botverse-sentinella`.

For normal (non-shared) agents, `CLAUDE_CONFIG_DIR` is not set — CC uses the default `~/.claude/` as usual. Only shared instances get the override.

In Docker mode, the host-side `.claude/` dir is bind-mounted into the container so CC inside the container reads/writes sessions to the host filesystem. This means sessions persist across container restarts.

### CC Runs Inside Docker

CC must run inside the container because:
- The guest's project may need system libraries (GDAL, CUDA, etc.) that aren't on the host
- CC's bash tool needs to execute in the project's runtime environment (`pip install`, `npm test`, etc.)
- File paths must match — CC's cwd and the guest's SSH cwd are the same filesystem

TGCC communicates with CC inside the container via a **Unix domain socket** relay — same protocol as the existing MCP bridge, but for the CC process stdio.

### CC Native Sandboxing

CC provides process-level sandboxing via `@anthropic-ai/sandbox-runtime`:

| Feature | Mechanism |
|---------|-----------|
| Filesystem isolation | bubblewrap namespaces — `allowWrite[]`, `denyWrite[]`, `allowRead[]`, `denyRead[]` |
| Network restrictions | Domain allowlists/blocklists, SSRF guard (blocks private ranges) |
| System call filtering | seccomp profiles — blocks dangerous syscalls |
| Settings protection | Hardcoded blocks on `.claude/settings.json`, `.claude/skills/`, git internals |
| Command validation | Bash tool validates commands against read-only allowlists |

CC's sandbox runs *inside* the container — defense in depth. Docker provides the outer ring (host protection), CC provides the inner ring (project protection within the container).

## Architecture

### Docker Mode (Primary)

```
Guest (Telegram / VS Code / SSH)
    │
    ├─ Tailscale ──► Container [project-name.ts.net]
    │                  ├── CC CLI process
    │                  ├── tgcc-relay (socket ↔ CC stdio)
    │                  ├── sshd (port 22)
    │                  ├── Project deps (.local/)
    │                  └── /home/project (bind-mount)
    │
    └─ Telegram ──► TGCC server (host)
                       │
                       └── Unix socket ──► tgcc-relay ──► CC process
                                           (inside container)
```

### Local Mode (Lightweight)

For trusted collaborators who don't need SSH/IDE access and where the host already has the project's dependencies:

```
Guest (Telegram only)
    │
    └─ Telegram ──► TGCC server
                       │
                       └── CC process (local, sandboxed)
                           ├── CLAUDE_CONFIG_DIR=~/.tgcc/agents/<id>/repos/<slug>/.claude/
                           ├── cwd = /path/to/project
                           └── --permission-mode plan
```

No container. TGCC spawns CC directly with isolated config dir. Same as a normal agent but with separate sessions/memory.

## Socket Relay Protocol

### `tgcc-relay` (runs inside container)

A thin daemon that bridges the Unix socket to CC's stdio:

- Listens on `/run/tgcc/bridge.sock` (bind-mounted from host)
- Spawns and manages the CC CLI process on command
- Relays CC's stdout (NDJSON stream events) back over the socket
- Forwards user messages from the socket to CC's stdin
- Reports process lifecycle events (spawned, exited, error)

### Wire Protocol

JSON-over-newline on the Unix socket. Same structure as CC's stdin/stdout protocol, wrapped in envelope messages:

```
Host → Container:
  {"type":"spawn","args":["--model","sonnet","--permission-mode","plan"]}
  {"type":"message","content":{"type":"human","message":"Fix the bug"}}
  {"type":"kill"}
  {"type":"cancel"}
  {"type":"tool_result","tool_use_id":"abc","content":"approved"}

Container → Host:
  {"type":"spawned","pid":1234,"session_id":"abc-123"}
  {"type":"stream","event":{...CC NDJSON stream event...}}
  {"type":"exited","code":0}
  {"type":"error","message":"spawn failed: ..."}
```

### `ContainerCCProcess` (in TGCC)

A new class in `cc-process.ts` that implements the same `CCProcess` event interface but connects via Unix socket instead of spawning locally:

```typescript
class ContainerCCProcess extends EventEmitter {
  private socket: net.Socket;

  constructor(socketPath: string, options: CCProcessOptions) {
    // Connect to tgcc-relay socket instead of spawning a process
  }

  // Same public API as CCProcess:
  sendMessage(msg: UserMessage): void;
  kill(): void;
  cancel(): void;
  sendToolResult(toolUseId: string, content: string): void;
  respondToPermission(requestId: string, allowed: boolean): void;
}
```

Bridge.ts doesn't need to know whether it's talking to a local or container CC — both emit the same events.

## Project Configuration

### Agent Config (`~/.tgcc/config.json`)

Whether an agent runs locally or in Docker is defined on the agent itself via the `share` block. This is a per-agent decision — the same project could be shared to one guest locally and another via Docker.

```json
{
  "agents": {
    "kyo_team": {
      "botToken": "...",
      "allowedUsers": ["guest-tg-id"],
      "defaults": {
        "repo": "kyo",
        "permissionMode": "plan",
        "model": "claude-sonnet-4-6"
      },
      "share": {
        "mode": "docker",
        "claude_md": ".tgcc/CLAUDE.md",
        "docker": {
          "networks": ["supabase_network_KYO"],
          "env": {
            "NEXT_PUBLIC_SUPABASE_URL": "http://supabase_kong_KYO:8000",
            "DATABASE_URL": "postgresql://postgres:postgres@supabase_db_KYO:5432/postgres"
          },
          "volumes": {
            "/data/shared-assets": "/home/project/assets"
          },
          "resources": { "cpus": 2, "memory": "4g" }
        }
      }
    }
  }
}
```

The `share` block is what marks an agent as sandboxed. When present, TGCC:
1. Creates an isolated `CLAUDE_CONFIG_DIR` at `~/.tgcc/agents/<agentId>/repos/<repo-slug>/.claude/`
2. Copies `claude_md` into it (if specified, path relative to project root)
3. (Docker mode) Starts a container with the specified networks, env, volumes, and resources
4. (Local mode) Spawns CC directly with `CLAUDE_CONFIG_DIR` set

Fields:
- `mode` — `"local"` or `"docker"` (default: `"docker"`)
- `claude_md` — path (relative to project root) to a CLAUDE.md for the shared instance
- `docker` — Docker-specific settings (ignored in local mode):
  - `networks` — Docker networks to attach (e.g. join Supabase's network so the container can reach the DB by container name)
  - `env` — environment variable overrides (remap `localhost` addresses to Docker container hostnames)
  - `env_file` — path to a file with additional env vars
  - `volumes` — extra bind-mounts beyond the project dir (`host:container`)
  - `resources` — cgroup limits (`cpus`, `memory`)
- `sandbox` — CC sandbox settings (both modes):
  - `allowedDomains` — network allowlist passed to CC's sandbox config

### `.tgcc/CLAUDE.md` (in project repo, optional)

Project-specific instructions for the shared CC instance, referenced by the agent's `share.claude_md` field. Copied to the isolated `CLAUDE_CONFIG_DIR`:

### `.tgcc/CLAUDE.md`

Project-specific instructions for the shared CC instance. Copied to the isolated `CLAUDE_CONFIG_DIR`. Controls what the guest's CC can see and do:

```markdown
# Project: Sentinella

You are working on the Sentinella satellite imagery pipeline.
Only modify files in src/ and tests/. Do not touch infrastructure/ or deploy/.
Always run tests before committing.
```

### Dependency Installation

No special setup mechanism needed. The project dir is bind-mounted read-write, so dependencies install into it naturally:

- **Node.js**: `npm install` → `node_modules/` in the project dir (already project-local)
- **Python**: `pip install -r requirements.txt` → installs into container's Python, or `pip install --prefix=.local` for project-local
- **System packages**: Baked into the base image (build-essential, common libs). For heavy stacks (GDAL, CUDA), use a project-specific image tag or extend the base

CC inside the container can install deps via bash tool — the guest just asks. No entrypoint scripts needed.

## Docker Container Image

One generic image for all projects. Project-specific deps install into the bind-mounted project dir at runtime:

```dockerfile
FROM ubuntu:24.04

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-server \
    build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev \
    libsqlite3-dev libncurses-dev libffi-dev liblzma-dev \
    python3 python3-pip python3-venv \
    && mkdir /run/sshd && rm -rf /var/lib/apt/lists/*

# Node.js (for CC CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs

# CC CLI
RUN npm install -g @anthropic-ai/claude-code

# Micromamba for native deps
RUN curl -fsSL https://micro.mamba.pm/api/micromamba/linux-64/latest \
    | tar -xj -C /usr/local/bin --strip-components=1 bin/micromamba

# Tailscale
RUN curl -fsSL https://tailscale.com/install.sh | sh

# Socket relay daemon
COPY tgcc-relay /usr/local/bin/tgcc-relay

# Environment: resolve .local/ first
ENV LOCAL_PREFIX=/home/project/.local
ENV PATH="$LOCAL_PREFIX/bin:$LOCAL_PREFIX/conda/bin:$PATH"
ENV LD_LIBRARY_PATH="$LOCAL_PREFIX/lib:$LOCAL_PREFIX/conda/lib"
ENV NODE_PATH="$LOCAL_PREFIX/lib/node_modules"

# Non-root user
RUN useradd -m -s /bin/bash -d /home/project project
USER project
WORKDIR /home/project

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/tgcc-relay"]
```

### Container Bind Mounts

```bash
docker run \
  --name tgcc-<name> \
  # Bind mounts
  -v /path/to/project:/home/project \
  -v /run/tgcc/sockets/<name>.sock:/run/tgcc/bridge.sock \
  -v ~/.tgcc/agents/<agentId>/repos/<slug>/.claude:/home/project/.claude-config \
  # Extra volumes from share.json
  -v /data/shared-assets:/home/project/assets \
  # Isolation
  --read-only --tmpfs /tmp \
  --cpus 2 --memory 4g \
  # Docker networks (join existing service networks)
  --network supabase_network_KYO \
  # Environment: CC config + remapped service addresses
  -e CLAUDE_CONFIG_DIR=/home/project/.claude-config \
  -e ANTHROPIC_API_KEY=<key> \
  -e TS_AUTHKEY=<key> \
  -e NEXT_PUBLIC_SUPABASE_URL=http://supabase_kong_KYO:8000 \
  -e DATABASE_URL=postgresql://postgres:postgres@supabase_db_KYO:5432/postgres \
  --env-file .tgcc/env \
  tgcc/sandbox:latest
```

Key mounts:
- **Project dir** → `/home/project` (read-write, deps install here via `npm install` / `pip install --prefix`)
- **Socket** → `/run/tgcc/bridge.sock` (relay ↔ TGCC communication)
- **Config dir** → `/home/project/.claude-config` (sessions, memory, settings — persisted on host)
- **Extra volumes** → from `docker.volumes` in share.json

## TGCC Integration

### Config Dir Management

```typescript
import { computeProjectSlug } from './session.js';

function getSharedConfigDir(agentId: string, repoPath: string): string {
  const slug = computeProjectSlug(repoPath);
  return join(homedir(), '.tgcc', 'agents', agentId, 'repos', slug, '.claude');
}
```

When sharing a project:
1. Create the config dir: `mkdirSync(configDir, { recursive: true })`
2. Copy `.tgcc/CLAUDE.md` → `configDir/CLAUDE.md`
3. Generate `configDir/settings.json` from `share.json` (permissions, sandbox rules)
4. For local mode: set `CLAUDE_CONFIG_DIR` env var when spawning CC
5. For Docker mode: bind-mount the config dir into the container

### `ContainerCCProcess` Class

New class alongside `CCProcess` in `cc-process.ts`:

```typescript
class ContainerCCProcess extends EventEmitter {
  // Connects to tgcc-relay via Unix socket
  // Emits same events as CCProcess: init, text, tool_use, result, etc.
  // Same public API: sendMessage, kill, cancel, sendToolResult, respondToPermission
}
```

Bridge.ts uses a factory to get the right process type:

```typescript
function createCCProcess(agent: AgentInstance, options: CCProcessOptions): CCProcess | ContainerCCProcess {
  if (agent.shared?.mode === 'docker') {
    return new ContainerCCProcess(agent.shared.socketPath, options);
  }
  return new CCProcess(options);
}
```

### MCP Tools

```
tgcc_share(projectPath, guestChatId?, mode?)
  → Creates config dir, registers agent, starts container (Docker mode)

tgcc_unshare(projectName)
  → Kills CC, removes agent, stops container

tgcc_projects()
  → Lists active shared projects: name, mode, guest, uptime, cost
```

### Lifecycle

#### Share
```
tgcc_share /path/to/project --guest @username
  │
  ├── 1. Read .tgcc/share.json for settings
  ├── 2. Create ~/.tgcc/agents/<agentId>/repos/<slug>/.claude/
  ├── 3. Copy .tgcc/CLAUDE.md → configDir/CLAUDE.md
  ├── 4. Generate configDir/settings.json (permissions, sandbox config)
  ├── 5. Register as TGCC agent (type: shared, chatId: guest's TG chat)
  ├── 6. (Docker) Create Tailscale ephemeral auth key
  ├── 7. (Docker) docker run with:
  │       - bind mounts (project dir, socket, config dir, extra volumes)
  │       - --network for each network in docker.networks
  │       - env vars from docker.env + docker.env_file
  │       - resource limits from docker.resources
  ├── 8. (Docker) Container starts: tgcc-relay + tailscaled + sshd
  └── 9. Notify guest: "Project <name> shared with you"
```

#### Unshare
```
tgcc_unshare <name>
  │
  ├── 1. Kill CC process
  ├── 2. Remove TGCC agent registration
  ├── 3. (Docker) docker stop + docker rm
  ├── 4. (Docker) Revoke Tailscale auth key
  └── 5. Config dir preserved (--purge to delete)
```

## Sandboxing Summary

### Defense in Depth

| Layer | Provider | What it Protects |
|-------|----------|-----------------|
| Docker container | Docker | Host from guest (namespaces, cgroups, read-only root) |
| CC sandbox | CC native (bwrap + seccomp) | Project from CC (filesystem, network, syscall filtering) |
| Network isolation | Docker + Tailscale | No `--network host`; Tailscale-only guest ingress |
| Session isolation | TGCC | `CLAUDE_CONFIG_DIR` separates sessions/memory per shared project |
| Permission mode | CC native | `plan` / `acceptEdits` restricts what CC can do without approval |
| CLAUDE.md | Project owner | Instructions scope CC's behavior to project needs |
| MCP restrictions | TGCC | Shared agents get minimal MCP tools (no supervisor, no spawning) |

## Resolved Questions

1. **Guest identity**: Telegram chat ID for CC access. Tailscale identity for SSH. Independent auth paths.
2. **Multi-guest**: 1:1 — one CC process per shared project. Multiple guests = multiple shared instances (separate agents, same repo).
3. **Git integration**: Left to the guest. CC can commit/push if the guest asks.
4. **Billing**: `total_cost_usd` tracked per agent in TGCC. Hard budget limit configurable in share.json.
5. **MCP forwarding**: Shared instances get minimal MCP — `send_message`, `send_file`, `send_image`, `notify_supervisor`. No browser, no agent spawning, no supervisor tools.
6. **Dep installation**: No special mechanism. Project dir is bind-mounted read-write. CC runs inside Docker, so `npm install` / `pip install` via bash tool works normally — deps land in the project dir (or container filesystem for system packages).

## Open Questions

1. **Config dir cleanup**: Preserve by default on unshare. `--purge` to delete. How long to keep stale config dirs?
2. **Guest permissions escalation**: If the guest's CC needs to run something blocked by the sandbox, should TGCC forward the permission_request to the project owner via TG?
3. **Hot-reload**: If `.tgcc/share.json` changes while shared, auto-reload or require `tgcc_reshare`?
4. **Container updates**: When the base image updates (new CC version, security patches), how to roll containers forward? `tgcc_reshare --rebuild`?
