# Implementation Tasks

No phases. Ship it all.

## Project Setup
- [ ] Init pnpm project with TypeScript
- [ ] Add dependencies: grammy, @modelcontextprotocol/sdk, uuid, pino
- [ ] Configure tsc build
- [ ] Config loader (`~/.tgcc/config.json`)

## CC Process Manager (`cc-process.ts`)
- [ ] Spawn CC with stream-json flags + `--include-partial-messages`
- [ ] NDJSON line parser on stdout
- [ ] Write user messages to stdin
- [ ] Idle timeout → kill process
- [ ] Respawn with `--continue` on next message
- [ ] Error handling (crash, hang detection)
- [ ] Pass MCP config for send_file/send_image tools

## CC Protocol (`cc-protocol.ts`)
- [ ] Construct text user message
- [ ] Construct image user message (base64 content blocks)
- [ ] Parse `stream_event` for content deltas (text + thinking)
- [ ] Parse `assistant` messages (full, for non-streaming fallback)
- [ ] Parse `result` events (cost, session_id)
- [ ] Parse `tool_use` events (for status display)
- [ ] Parse `system.init` event (store session_id)

## Streaming (`streaming.ts`)
- [ ] Accumulate `text_delta` chunks into buffer
- [ ] Throttled TG message editing (max 1 edit/sec, min 200 chars between edits)
- [ ] First chunk → sendMessage, subsequent → editMessageText
- [ ] Thinking indicator: "🤔 Thinking..." during thinking blocks
- [ ] Tool use indicator: "🔧 Using [tool]..." during tool_use blocks
- [ ] Replace indicators with actual text when content arrives
- [ ] Final edit on message_stop

## Telegram Bot (`telegram.ts`)
- [ ] grammy bot setup with long polling
- [ ] Multi-bot support (one grammy instance per agent/bot token)
- [ ] Text message handler → bridge
- [ ] Photo handler → download → base64 → bridge
- [ ] Document handler → download → save to disk → bridge
- [ ] Reply formatting (markdown, code blocks)
- [ ] Message splitting for >4096 chars
- [ ] allowedUsers filter per agent
- [ ] Slash command registration and handling

## Bridge (`bridge.ts`)
- [ ] Multi-agent: agent config → CC process mapping
- [ ] Route TG messages to correct CC stdin
- [ ] Route CC output to correct TG chat (via streaming module)
- [ ] Handle process lifecycle (spawn/idle/respawn)
- [ ] Queue messages while CC is spawning

## MCP Server (`mcp-server.ts`)
- [ ] Stdio MCP server using @modelcontextprotocol/sdk
- [ ] `send_file` tool — read file, IPC to bridge, bridge sends to TG
- [ ] `send_image` tool — same but sent as TG photo for preview
- [ ] `send_voice` tool — send as TG voice note (.ogg opus)

## MCP Bridge IPC (`mcp-bridge.ts`)
- [ ] Unix socket server in bridge process
- [ ] Accept tool call requests from MCP server
- [ ] Route to correct TG chat via user_id
- [ ] Return success/error to MCP server
- [ ] Generate per-agent MCP config JSON at spawn time

## Session Management (`session.ts`)
- [ ] JSON file persistence
- [ ] Track session history per user per agent
- [ ] Store current session ID, model, repo

## Slash Commands
- [ ] `/new` — fresh session
- [ ] `/sessions` — list recent sessions
- [ ] `/resume <id>` — resume specific session
- [ ] `/session` — current session info
- [ ] `/model <name>` — switch model
- [ ] `/repo <path>` — set working directory
- [ ] `/cost` — show cost for current session
- [ ] `/status` — process state, uptime, model
- [ ] `/catchup` / `/whatdidimiss` — read CC session history from outside TG, summarize
- [ ] `/help` — list commands

## Multi-Agent Config
- [ ] Config supports multiple agents, each with: bot token, allowed users, default repo, model
- [ ] Hot reload: watch config file, add/remove bots without restart (grammy bot start/stop)
- [ ] Each agent gets its own CC process per user

## Reliability
- [ ] Graceful shutdown (SIGTERM handler, kill all CC processes)
- [ ] Process cleanup on exit
- [ ] Logging (pino)
- [ ] Startup self-test (verify CC binary, validate config)
