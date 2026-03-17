# Project Sharing via Containerized Dev Environments

## Concept

Share a project with someone by giving them access to:
1. A **Telegram agent** (TGCC worker) scoped to the project
2. A **VS Code Remote** IDE connected to the project repo
3. A **Tailscale hostname** for SSH access — no port forwarding or VPN

All running in an isolated Docker container.

## Architecture

```
Guest (Telegram / VS Code / SSH)
    │
    ├─ Tailscale ──► Container [project-name.ts.net]
    │                  ├── CC CLI process
    │                  ├── VS Code Remote Server (sshd)
    │                  ├── Project deps (AWS CLI, GEE, GDAL, etc.)
    │                  └── /home/project (bind-mount, only visible dir)
    │
    └─ Telegram ──► TGCC server (host)
                       │
                       └── Unix socket ──► CC process inside container
```

### Communication: Unix Socket

TGCC server (host) ↔ CC process (container) communicate via a **Unix domain socket** bind-mounted into the container.

- Path on host: `/run/tgcc/sockets/<project-name>.sock`
- Path in container: `/run/tgcc/bridge.sock`
- No network exposure, lowest latency, simplest setup
- TGCC sends commands (spawn CC, send prompt, kill) over the socket
- CC process streams events back over the same socket

### Container Internals

A thin daemon inside the container listens on the socket and:
- Spawns/manages the CC CLI process on demand
- Relays stdin/stdout between the socket and CC
- Reports health/status back to TGCC

This makes the container self-contained — TGCC just sends messages, doesn't need Docker exec access.

### Tailscale Networking

- Each container gets an **ephemeral Tailscale auth key** with tag `tag:tgcc-project`
- ACL: guests with `tag:tgcc-guest` can access `tag:tgcc-project` on port 22 only
- Container appears as `<project-name>.ts.net` in the tailnet
- Guest SSHs to `<project-name>.ts.net` → lands in `/home/project`
- VS Code Remote connects to the same hostname
- Revoking access = stop container + expire Tailscale key

## Project Dependencies

**One generic container for all projects.** Dependencies are installed into the project directory under `.local/`, not baked into the image. This keeps the image small and reusable, and makes deps portable and git-excludable.

### Project Directory Layout

```
project/
├── .tgcc/
│   ├── setup.sh          # idempotent dep install script (committed to git)
│   ├── config.json        # project sharing settings (permissions, resource limits)
│   └── env                # non-secret env vars for the container
├── .local/
│   ├── bin/              # executables (aws, gdalinfo, python, etc.)
│   ├── lib/              # shared libraries, Python site-packages
│   ├── include/          # headers (for native extension builds)
│   ├── share/            # data files, man pages
│   └── conda/            # conda environment (if used)
├── .gitignore            # includes .local/
└── ... project files ...
```

**`.tgcc/`** — project config, committed to git. Setup script, sharing settings, env vars.
**`.local/`** — installed prefix tree, gitignored. Pure output of `setup.sh`.

The container sets `PATH`, `LD_LIBRARY_PATH`, `PYTHONPATH`, etc. to resolve `.local/` first. From the project's perspective, deps just work — `aws`, `python`, `gdalinfo` are all on PATH.

### `.tgcc/setup.sh`

Idempotent script that installs everything into `.local/`:

```bash
#!/bin/bash
set -euo pipefail
LOCAL="$(pwd)/.local"
mkdir -p "$LOCAL"/{bin,lib,include,share}

# Python packages → .local/lib/python3.x/site-packages/
pip install --prefix="$LOCAL" -r requirements.txt

# Node packages → .local/lib/node_modules/ + .local/bin/
npm install --prefix="$LOCAL"

# Static binaries → .local/bin/
curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/aws.zip
unzip -qo /tmp/aws.zip -d /tmp && /tmp/aws/install -i "$LOCAL" -b "$LOCAL/bin"

# System libraries that aren't in the base image
# Option A: conda/mamba into .local/conda/
# Option B: download pre-built .so files into .local/lib/
```

The container's entrypoint runs `.tgcc/setup.sh` on first boot (if `.local/` is empty or `setup.sh` is newer than `.local/`).

### `.tgcc/config.json`

```json
{
  "name": "sentinella",
  "permissions": "plan",
  "resources": { "cpus": 2, "memory": "4g" },
  "env_file": ".tgcc/env",
  "idle_timeout": "24h"
}
```

### What Goes Where

| Kind | Install method | Location |
|------|---------------|----------|
| Python packages | `pip install --prefix=.local` | `.local/lib/python3.x/site-packages/` |
| Node packages | `npm install --prefix=.local` | `.local/lib/node_modules/`, `.local/bin/` |
| CLI tools | Download static binary | `.local/bin/` |
| Native libraries (GDAL, proj) | `conda create -p .local/conda` or pre-built | `.local/conda/` or `.local/lib/` |
| Go/Rust tools | Build or download binary | `.local/bin/` |

For heavy native stacks (GDAL, CUDA, etc.), **conda/mamba** is the escape hatch — it bundles system libs + Python bindings into a single prefix without needing root:

```bash
# In setup.sh
micromamba create -p "$LOCAL/conda" -c conda-forge gdal rasterio proj python=3.11 -y
```

### Generic Container Image

The base image is project-agnostic. It provides the runtime shell and lets `.tgcc/setup.sh` handle the rest:

```dockerfile
FROM ubuntu:24.04

# Essentials only — project deps go in .local/
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git openssh-server \
    build-essential libssl-dev zlib1g-dev libbz2-dev libreadline-dev \
    libsqlite3-dev libncurses-dev libffi-dev liblzma-dev \
    && mkdir /run/sshd && rm -rf /var/lib/apt/lists/*

# Node.js (for CC CLI)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs

# CC CLI
RUN npm install -g @anthropic-ai/claude-code

# direnv — auto-loads .envrc on cd, wires up .local/ PATH etc.
RUN curl -fsSL https://direnv.net/install.sh | bash

# Micromamba (for projects that need native libs)
RUN curl -fsSL https://micro.mamba.pm/api/micromamba/linux-64/latest \
    | tar -xj -C /usr/local/bin --strip-components=1 bin/micromamba

# Tailscale
RUN curl -fsSL https://tailscale.com/install.sh | sh

# Socket daemon (thin relay between TGCC and CC)
COPY tgcc-relay /usr/local/bin/tgcc-relay

# Environment: resolve .local/ first
ENV LOCAL_PREFIX=/home/project/.local
ENV PATH="$LOCAL_PREFIX/bin:$LOCAL_PREFIX/conda/bin:$PATH"
ENV LD_LIBRARY_PATH="$LOCAL_PREFIX/lib:$LOCAL_PREFIX/conda/lib"
ENV NODE_PATH="$LOCAL_PREFIX/lib/node_modules"

EXPOSE 22
ENTRYPOINT ["/usr/local/bin/tgcc-relay"]
```

One image. All projects. `docker pull tgcc/sandbox:latest` and go.

## Sandboxing

### What Docker provides (host protection)

| Layer | Mechanism |
|-------|-----------|
| Filesystem | Bind-mount only project dir; `--read-only` root + tmpfs for /tmp |
| Network | Tailscale only (no `--network host`); allowlist Anthropic API, Telegram API, AWS, GEE |
| Capabilities | Drop all; no `--privileged` |
| Resources | cgroup limits on CPU/memory per container |
| User | Non-root user inside container; user namespaces |

### What CAN'T be sandboxed

| Risk | Explanation | Mitigation |
|------|-------------|------------|
| Project contents from guest | Guest has SSH shell = full read/write on project dir. That's the point — they're a collaborator. | Permission-scoped access (read-only mounts for sensitive subdirs if needed) |
| Credentials | AWS creds, GEE service accounts, Anthropic API key must be in the container for tools to work | Use per-project scoped IAM roles/keys with minimal permissions. Never share root credentials. |
| CC behavior | CC process inside container can do anything the container user can | Use `--permission-mode plan` or `acceptEdits`; TGCC worker config enforces behavior |
| MCP servers | Some MCPs (browser, etc.) won't work headless | Provide only relevant MCPs per project |

### Threat model

The primary threat model is **protecting the host from the guest**, not the project from the guest. Docker handles this well. If you need to protect specific project assets from the guest, use read-only sub-mounts or separate secrets management.

## Container Lifecycle

### Startup flow

```
tgcc share <project-path>
  │
  ├── 1. Read .tgcc/config.json for project settings
  ├── 2. Pull tgcc/sandbox:latest (if not cached)
  ├── 3. Create Tailscale ephemeral auth key (tagged: tgcc-project)
  ├── 4. docker run with:
  │       --name tgcc-<project-name>
  │       -v /path/to/project:/home/project
  │       -v /run/tgcc/sockets/<project-name>.sock:/run/tgcc/bridge.sock
  │       --read-only --tmpfs /tmp
  │       --cpus/--memory from .tgcc/config.json
  │       --env-file .tgcc/env
  │       -e TS_AUTHKEY=<key>
  │       -e ANTHROPIC_API_KEY=<key>
  ├── 5. Container starts: tailscaled + sshd + tgcc-relay
  ├── 6. Entrypoint runs .tgcc/setup.sh → installs deps into .local/
  ├── 7. Register worker in TGCC with socket path
  └── 8. Return: "Project shared at <project-name>.ts.net"
```

### Teardown

```
tgcc unshare <project-name>
  │
  ├── 1. Send shutdown to CC process via socket
  ├── 2. docker stop + docker rm
  ├── 3. Revoke Tailscale auth key
  └── 4. Remove socket file
```

### Persistence

- Project files + `.local/`: bind-mounted, survives container restart
- Project config: `.tgcc/` in the project repo (committed to git)
- CC session state: ephemeral (TGCC handles re-spawn on restart)
- Host-side state: socket files in `/run/tgcc/sockets/`

## TGCC Integration Changes

### Socket-based worker spawning

Currently TGCC spawns CC directly (`cc-process.ts`). For containerized workers:

1. New worker type: `container` (vs current `local`)
2. `cc-process.ts` gains a `ContainerCCProcess` class that:
   - Connects to the Unix socket instead of spawning a child process
   - Sends prompts / receives stream events over the socket protocol
   - Handles reconnection if the container restarts
3. Worker config in TGCC registers the socket path per agent

### Socket protocol

Simple JSON-over-newline protocol on the Unix socket:

```
→ {"type":"spawn","model":"sonnet","permissions":"plan"}
← {"type":"spawned","pid":1234}
→ {"type":"prompt","text":"Fix the bug in auth.py"}
← {"type":"stream","event":{...CC stream event...}}
← {"type":"stream","event":{...}}
← {"type":"idle"}
→ {"type":"kill"}
← {"type":"killed"}
```

### Worker restriction

The TGCC worker config gains a `containerOnly: true` flag. When set:
- The worker CANNOT spawn local CC processes
- All CC operations go through the socket to the container
- The worker's MCP config is scoped to container-safe tools only

## Multi-project Resource Management

For N shared projects = N containers:

- **Docker Compose per project** — simplest. Each project gets a `docker-compose.yml` in `~/.tgcc/projects/<name>/`
- **Resource limits** — each container gets CPU/memory caps via cgroups
- **Monitoring** — `tgcc projects` lists all active shared projects with status, resource usage, uptime
- **Auto-cleanup** — containers idle for >24h get stopped (configurable)

## Cost Considerations

- Each active CC process burns API credits
- Per-project API key or usage tracking needed
- Hard token/cost limits per project session (configurable in worker config)
- Usage footer in Telegram shows cost to the guest

## Open Questions

1. **Guest identity**: Should the guest authenticate to TGCC via Telegram? Or is Tailscale identity sufficient?
2. **Multi-guest**: Can multiple guests share one project container? (Probably not — CC is single-user)
3. **Git integration**: Should the container auto-commit/push? Or leave that to the guest?
4. **Billing**: How to track/limit API costs per shared project?
5. **MCP forwarding**: Some host MCPs (like `patchright` browser) can't run headless in container. Forward them via socket? Or just exclude?
