# tgcc

Telegram ↔ Claude Code CLI bridge. Pipes Telegram bot messages to persistent Claude Code CLI processes.

## Features

- 1:1 mapping between TG user and CC process
- Persistent sessions with `--continue` on reconnect
- Image support via base64 content blocks (confirmed working)
- Document/file piping
- Session management (`/new`, `/sessions`, `/resume`)
- Auto file output detection (CC writes → TG sends)

## Setup

```bash
pnpm install
cp config.example.json ~/.tgcc/config.json
# Edit config with your bot token and settings
pnpm dev
```

## Architecture

See [.specs/ARCHITECTURE.md](.specs/ARCHITECTURE.md) for full design.
See [.specs/PROTOCOL.md](.specs/PROTOCOL.md) for CC stream-json protocol reference.
See [.specs/TASKS.md](.specs/TASKS.md) for implementation tasks.
