# OpenClaw Plugin for TGCC

## Overview

Package the TGCC supervisor integration as an **OpenClaw community plugin** that lives in this repo (`@fonz/tgcc`). This replaces the fork-based approach (patching OpenClaw core) with a clean plugin that installs via `openclaw plugins install @fonz/tgcc`.

## Background

We currently maintain a fork of OpenClaw (`botverse/openclaw`, branch `feat/tgcc-supervisor`) with ~3400 lines of changes across 19 files. The maintainer (vincentkoc) closed our PR (#29088) and asked us to publish as a community plugin instead.

The fork adds:
- **`src/agents/tgcc-supervisor/client.ts`** — Unix socket client for TGCC's control protocol
- **`src/agents/tgcc-supervisor/index.ts`** — Event handlers, session lifecycle, permission relay
- Changes to `subagent-spawn.ts`, `subagent-registry.ts`, `subagents-tool.ts`, `sessions-send-tool.ts` etc.
- Config schema additions for `agents.list[].tgcc`
- Telegram button handlers for permission approval

## Goal

Repackage the supervisor integration as an OpenClaw plugin (`plugin/` directory in this repo) that:
1. Connects to TGCC's Unix socket control protocol as a supervisor
2. Exposes agent tools for spawning/managing TGCC CC sessions
3. Relays observability events (result, error, permission_request) back to OpenClaw
4. Handles permission approval via Telegram inline buttons
5. Publishes as part of the existing `@fonz/tgcc` npm package

## Plugin Structure

```
plugin/
├── openclaw.plugin.json          # Plugin manifest
├── index.ts                      # Plugin entry point (registers tools + background service)
├── src/
│   ├── client.ts                 # TgccSupervisorClient (copy from fork, adapt imports)
│   ├── events.ts                 # Event handlers (result, error, permission, etc.)
│   ├── tools/
│   │   ├── tgcc-spawn.ts         # Tool: spawn a CC session via TGCC
│   │   ├── tgcc-send.ts          # Tool: send message to existing TGCC session
│   │   ├── tgcc-status.ts        # Tool: get status of TGCC agents/sessions
│   │   └── tgcc-kill.ts          # Tool: kill a TGCC session
│   └── permissions.ts            # Telegram button handler for permission approval
└── tsconfig.json                 # Plugin-local TS config (if needed)
```

## Plugin Manifest (`openclaw.plugin.json`)

```json
{
  "id": "tgcc",
  "name": "TGCC Bridge",
  "description": "Bridge OpenClaw agents to Claude Code sessions via TGCC (Telegram ↔ Claude Code)",
  "version": "0.6.19",
  "configSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "enabled": { "type": "boolean" },
      "socketDir": {
        "type": "string",
        "description": "Directory containing TGCC control sockets (default: /tmp/tgcc/ctl)"
      },
      "defaultAgent": {
        "type": "string",
        "description": "Default TGCC agent to use for spawns (e.g. 'tgcc')"
      },
      "agents": {
        "type": "array",
        "items": { "type": "string" },
        "description": "TGCC agent IDs to subscribe to (default: all)"
      }
    }
  }
}
```

## Plugin Entry Point (`index.ts`)

```ts
export default function (api: OpenClawPluginApi) {
  // 1. Read plugin config
  const config = api.getConfig();
  
  // 2. Register background service (connects to TGCC socket on startup)
  api.registerService({
    name: 'tgcc-supervisor',
    async start() { /* connect to socket, register as supervisor, subscribe to events */ },
    async stop() { /* disconnect cleanly */ },
  });

  // 3. Register agent tools
  api.registerTool({ name: 'tgcc_spawn', ... });
  api.registerTool({ name: 'tgcc_send', ... });
  api.registerTool({ name: 'tgcc_status', ... });
  api.registerTool({ name: 'tgcc_kill', ... });

  // 4. Register Telegram callback handler for permission buttons
  api.registerCallbackHandler?.('tgcc_perm', ...);
}
```

## Key Implementation Details

### Client (`src/client.ts`)
- Port the `TgccSupervisorClient` from the fork (`src/agents/tgcc-supervisor/client.ts`)
- Remove imports from OpenClaw internals — use only the plugin API
- Connect to TGCC control sockets at `{socketDir}/{agentId}.sock`
- Register as supervisor with `{"type": "register_supervisor", "agentId": "openclaw", "capabilities": ["exec", "notify"]}`
- Parse newline-delimited JSON events from the socket

### Event Handling (`src/events.ts`)
- **`cc_spawned`** — Track new sessions, notify agent
- **`result`** — Session completed, announce to parent agent via `api.runtime.sessions.announce()`
- **`process_exit`** — CC died unexpectedly, notify parent
- **`permission_request`** — Forward to Telegram as inline buttons (✅ Allow / ❌ Deny)
- **`api_error`** — Rate limit / overload, log and notify
- **`session_takeover`** — Another CC attached to the session, update tracking

### Tools
Each tool uses the supervisor client to send commands to TGCC:

- **`tgcc_spawn`** — `{"type": "command", "action": "create_agent", "params": {agentId, repo, model, task}}`
- **`tgcc_send`** — `{"type": "command", "action": "send_message", "params": {agentId, text}}`
- **`tgcc_status`** — `{"type": "command", "action": "status"}`
- **`tgcc_kill`** — `{"type": "command", "action": "destroy_agent", "params": {agentId}}`

### Permission Relay
When TGCC sends a `permission_request` event:
1. Plugin sends a Telegram message with inline keyboard (✅ Allow / ❌ Deny / ✅ Always)
2. On button press, plugin sends response back through the socket:
   `{"type": "command", "action": "permission_response", "params": {agentId, requestId, decision}}`

### Integration with OpenClaw's Subagent System
The plugin needs to hook into OpenClaw's subagent tracking so that:
- `sessions_spawn` with `runtime: "tgcc"` routes through this plugin
- Subagent completion events trigger the normal announce flow
- `subagents list` shows TGCC sessions

This is the trickiest part — check if `api.runtime` exposes subagent registry methods, or if we need to use tool responses to bridge the gap.

## Build & Publish

The plugin TypeScript gets compiled as part of the existing `npm run build` (add `plugin/` to tsconfig paths). The `openclaw.plugin.json` and compiled JS ship in the npm package.

Users install with:
```bash
openclaw plugins install @fonz/tgcc
```

Then configure:
```yaml
plugins:
  entries:
    tgcc:
      enabled: true
      config:
        socketDir: /tmp/tgcc/ctl
        defaultAgent: tgcc
```

## Migration Path

1. Build the plugin in `plugin/` directory
2. Test locally via `plugins.load.paths` pointing at the plugin dir
3. Once working, remove the fork dependency — run stock OpenClaw + this plugin
4. Submit PR to OpenClaw's community plugins page

## Open Questions

- Does the plugin API expose `api.runtime.sessions` or subagent registry methods? If not, we may need to use a workaround (e.g., injecting tool results that trigger the announce flow).
- Can plugins register Telegram callback query handlers? If not, permission buttons need a different approach (maybe HTTP webhook from TGCC).
- Should the plugin auto-discover TGCC agents by scanning the socket dir, or require explicit config?

## Source References

- Fork changes: `~/Projects/openclaw` branch `feat/tgcc-supervisor` (8 commits, 19 files)
- TGCC control protocol: `src/ctl-server.ts` in this repo
- OpenClaw plugin docs: https://docs.openclaw.ai/plugins/community
- Voice Call plugin (reference impl): OpenClaw `extensions/voice-call/`
