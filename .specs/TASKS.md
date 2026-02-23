# Implementation Tasks

## Phase 1 — Core Bridge (MVP)

### 1.1 Project Setup
- [ ] Init pnpm project with TypeScript
- [ ] Add dependencies: grammy, uuid
- [ ] Configure tsup/tsc build
- [ ] Basic config loader (`~/.tgcc/config.json`)

### 1.2 CC Process Manager (`cc-process.ts`)
- [ ] Spawn CC with stream-json flags
- [ ] NDJSON line parser on stdout
- [ ] Write user messages to stdin
- [ ] Idle timeout → kill process
- [ ] Respawn with `--continue` on next message
- [ ] Error handling (crash, hang detection)

### 1.3 CC Protocol (`cc-protocol.ts`)
- [ ] Construct text user message
- [ ] Construct image user message (base64 content blocks)
- [ ] Parse assistant text from output events
- [ ] Parse result events (cost, session_id)
- [ ] Parse tool_use events (for Write tool file detection)
- [ ] Parse init event (store session_id)

### 1.4 Telegram Bot (`telegram.ts`)
- [ ] grammy bot setup with long polling
- [ ] Text message handler → bridge
- [ ] Photo handler → download → base64 → bridge
- [ ] Document handler → download → save to disk → bridge
- [ ] Reply formatting (markdown, code blocks)
- [ ] Message splitting for >4096 chars
- [ ] Typing indicator while CC is working
- [ ] allowedUsers filter

### 1.5 Bridge (`bridge.ts`)
- [ ] User → CC process mapping
- [ ] Route TG messages to CC stdin
- [ ] Route CC output to TG messages
- [ ] Handle process lifecycle (spawn/idle/respawn)
- [ ] Queue messages while CC is spawning

## Phase 2 — Session Management

### 2.1 Commands
- [ ] `/new` — fresh session
- [ ] `/sessions` — list sessions
- [ ] `/resume <id>` — resume specific session
- [ ] `/session` — current session info
- [ ] `/model <name>` — switch model
- [ ] `/repo <path>` — set working directory
- [ ] `/cost` — show cost

### 2.2 Session Store (`session.ts`)
- [ ] JSON file persistence
- [ ] Track session history per user
- [ ] Store current session ID, model, repo

## Phase 3 — File Output

### 3.1 Output Detection
- [ ] Parse Write tool_use events
- [ ] Detect writes to output directory
- [ ] Auto-send files to TG as documents
- [ ] Clean up after sending

## Phase 4 — Polish

### 4.1 Reliability
- [ ] Graceful shutdown (SIGTERM handler)
- [ ] Process cleanup on exit
- [ ] Reconnection logic for TG polling
- [ ] Logging (pino or similar)

### 4.2 Quality of Life
- [ ] Format CC markdown for TG (convert unsupported elements)
- [ ] Cost tracking per session
- [ ] `/help` command
- [ ] Startup self-test (verify CC binary exists)
