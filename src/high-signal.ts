// ── High-Signal Event Detection for CC process observability ──
//
// Watches CC stream events for patterns that indicate meaningful progress,
// failures, or pressure. Emits supervisor events and pushes to EventBuffer.

import type { LogLine } from './event-buffer.js';
import type { StreamInnerEvent, StreamMessageStart } from './cc-protocol.js';

// ── Types ──

export interface HighSignalEvent {
  type: 'event';
  event: string;
  agentId: string;
  /** Populated by the emitter — emoji for the event type. */
  emoji?: string;
  /** Populated by the emitter — human-readable one-line summary. */
  summary?: string;
  [key: string]: unknown;
}

export interface HighSignalCallbacks {
  emitSupervisorEvent: (event: HighSignalEvent) => void;
  pushEventBuffer: (agentId: string, line: LogLine) => void;
}

interface ToolUseInfo {
  id: string;
  name: string;
  inputJson: string;
}

interface AgentState {
  // Failure loop tracking
  consecutiveFailures: number;
  failureLoopEmitted: boolean;
  lastFailedTool: string;
  lastFailedError: string;

  // Context pressure tracking
  contextThresholdsHit: Set<number>;

  // Sub-agent spawn tracking (per turn)
  spawnCountThisTurn: number;

  // Stuck detection
  lastOutputTs: number;
  stuckTimer: ReturnType<typeof setTimeout> | null;
  isExecutingTool: boolean;

  // Tool use tracking (tool_use_id → info)
  activeToolUses: Map<string, ToolUseInfo>;
  currentToolBlockId: string | null;

  // Cost tracking (cumulative per session)
  sessionCostUsd: number;
  budgetThresholdsHit: Set<number>;
}

// ── Constants ──

const BUILD_TEST_PATTERNS = /\b(npm run build|npm run test|npx tsc|tsc\b|jest\b|vitest\b|pytest\b|cargo test|go test|make\b|npm test|yarn build|yarn test|pnpm build|pnpm test)\b/i;
const GIT_COMMIT_PATTERN = /\bgit commit\b/i;
const SUBAGENT_TOOLS = new Set(['Task', 'dispatch_agent', 'create_agent', 'AgentRunner']);
const TODO_TOOLS = new Set(['TodoWrite', 'TodoRead']);
const BASH_TOOLS = new Set(['Bash', 'shell']);

const CONTEXT_THRESHOLDS = [50, 75, 90];
const CONTEXT_WINDOW_TOKENS = 200_000;
const FAILURE_LOOP_THRESHOLD = 3;
const DEFAULT_STUCK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_BUDGET_THRESHOLDS = [1, 5, 10, 25]; // USD

export class HighSignalDetector {
  private callbacks: HighSignalCallbacks;
  private agentStates = new Map<string, AgentState>();
  private stuckTimeoutMs: number;
  private budgetThresholds: number[];

  constructor(callbacks: HighSignalCallbacks, stuckTimeoutMs = DEFAULT_STUCK_TIMEOUT_MS, budgetThresholds = DEFAULT_BUDGET_THRESHOLDS) {
    this.callbacks = callbacks;
    this.stuckTimeoutMs = stuckTimeoutMs;
    this.budgetThresholds = budgetThresholds;
  }

  // ── Public API ──

  /**
   * Handle a stream event from CC (content_block_start, message_start, etc.)
   */
  handleStreamEvent(agentId: string, event: StreamInnerEvent): void {
    const state = this.getState(agentId);

    // Track output activity for stuck detection
    this.touchActivity(agentId, state);

    if (event.type === 'message_start') {
      // Reset per-turn state
      state.spawnCountThisTurn = 0;
      // Context pressure tracking
      this.checkContextPressure(agentId, state, event as StreamMessageStart);
    }

    if (event.type === 'content_block_start') {
      const block = (event as { content_block: { type: string; id?: string; name?: string } }).content_block;
      if (block.type === 'tool_use' && block.id && block.name) {
        // Track active tool use
        state.activeToolUses.set(block.id, { id: block.id, name: block.name, inputJson: '' });
        state.currentToolBlockId = block.id;
        state.isExecutingTool = true;
      }
    }

    // Accumulate tool input JSON for the current tool block
    if (event.type === 'content_block_delta') {
      const delta = (event as { delta?: { type: string; partial_json?: string } }).delta;
      if (delta?.type === 'input_json_delta' && delta.partial_json && state.currentToolBlockId) {
        const info = state.activeToolUses.get(state.currentToolBlockId);
        if (info) {
          info.inputJson += delta.partial_json;
        }
      }
    }

    if (event.type === 'content_block_stop') {
      // Sub-agent spawn detection — emit here so we have the full input JSON (task description)
      if (state.currentToolBlockId) {
        const info = state.activeToolUses.get(state.currentToolBlockId);
        if (info && SUBAGENT_TOOLS.has(info.name)) {
          state.spawnCountThisTurn++;
          const label = this.extractTaskLabel(info.inputJson);
          this.emit(agentId, {
            type: 'event',
            event: 'subagent_spawn',
            agentId,
            count: state.spawnCountThisTurn,
            toolName: info.name,
            label,
          });
        }
      }
      state.currentToolBlockId = null;
      // isExecutingTool stays true until tool_result comes back
    }
  }

  /**
   * Handle a tool_result event from CC
   */
  /** Call when a CC turn ends (result event). Cancels the stuck timer so idle agents don't fire false positives. */
  handleTurnEnd(agentId: string): void {
    const state = this.agentStates.get(agentId);
    if (!state) return;
    if (state.stuckTimer) {
      clearTimeout(state.stuckTimer);
      state.stuckTimer = null;
    }
    state.isExecutingTool = false;
    state.activeToolUses.clear();
  }

  handleToolResult(agentId: string, toolUseId: string, content: string, isError: boolean, toolName?: string): void {
    const state = this.getState(agentId);

    // Resolve tool name from tracked tool uses
    const toolInfo = state.activeToolUses.get(toolUseId);
    const resolvedToolName = toolName || toolInfo?.name || 'unknown';
    const toolInput = toolInfo?.inputJson || '';

    // Clean up tracked tool use
    state.activeToolUses.delete(toolUseId);
    state.isExecutingTool = state.activeToolUses.size > 0;

    // Track output activity
    this.touchActivity(agentId, state);

    // ── Failure loop detection ──
    if (isError || this.hasNonZeroExit(content)) {
      state.consecutiveFailures++;
      state.lastFailedTool = resolvedToolName;
      state.lastFailedError = content.length > 200 ? content.slice(0, 200) + '…' : content;

      if (state.consecutiveFailures >= FAILURE_LOOP_THRESHOLD && !state.failureLoopEmitted) {
        state.failureLoopEmitted = true;
        this.emit(agentId, {
          type: 'event',
          event: 'failure_loop',
          agentId,
          consecutiveFailures: state.consecutiveFailures,
          lastTool: state.lastFailedTool,
          lastError: state.lastFailedError,
        });
      }
    } else {
      // Success resets counter
      if (state.failureLoopEmitted && state.consecutiveFailures >= FAILURE_LOOP_THRESHOLD) {
        // Was in a failure loop, now recovered — reset emit flag for next potential loop
        state.failureLoopEmitted = false;
      }
      state.consecutiveFailures = 0;
      state.failureLoopEmitted = false;
    }

    // ── Build/test result detection (Bash tools only) ──
    if (BASH_TOOLS.has(resolvedToolName)) {
      const command = this.extractCommand(toolInput);
      if (command && BUILD_TEST_PATTERNS.test(command)) {
        this.detectBuildResult(agentId, command, content);
      }
      if (command && GIT_COMMIT_PATTERN.test(command)) {
        this.detectGitCommit(agentId, content);
      }
    }

    // ── Task milestone detection (TodoWrite) ──
    if (TODO_TOOLS.has(resolvedToolName)) {
      this.detectTaskMilestone(agentId, resolvedToolName, toolInput);
    }
  }

  /**
   * Handle an assistant message (for TodoWrite/Read tool_use blocks with full input)
   */
  handleAssistantToolUse(agentId: string, toolName: string, toolUseId: string, input: Record<string, unknown>): void {
    const state = this.getState(agentId);
    // Update tracked tool with parsed input
    const existing = state.activeToolUses.get(toolUseId);
    if (existing) {
      existing.inputJson = JSON.stringify(input);
    }
  }

  /**
   * Update session cost for an agent (called on result event with total_cost_usd).
   * Emits budget_alert events when configurable thresholds are crossed.
   */
  handleCostUpdate(agentId: string, totalCostUsd: number): void {
    const state = this.getState(agentId);
    state.sessionCostUsd = totalCostUsd;

    for (const threshold of this.budgetThresholds) {
      if (totalCostUsd >= threshold && !state.budgetThresholdsHit.has(threshold)) {
        state.budgetThresholdsHit.add(threshold);
        this.emit(agentId, {
          type: 'event',
          event: 'budget_alert',
          agentId,
          threshold,
          currentCost: totalCostUsd,
        });
      }
    }
  }

  /**
   * Get the current session cost for an agent.
   * Returns 0 if no cost data is available.
   */
  getSessionCost(agentId: string): number {
    return this.agentStates.get(agentId)?.sessionCostUsd ?? 0;
  }

  /**
   * Clean up state for an agent (on process exit)
   */
  cleanup(agentId: string): void {
    const state = this.agentStates.get(agentId);
    if (state?.stuckTimer) {
      clearTimeout(state.stuckTimer);
    }
    this.agentStates.delete(agentId);
  }

  /**
   * Destroy all state
   */
  destroy(): void {
    for (const [agentId] of this.agentStates) {
      this.cleanup(agentId);
    }
  }

  // ── Private: State management ──

  private getState(agentId: string): AgentState {
    let state = this.agentStates.get(agentId);
    if (!state) {
      state = {
        consecutiveFailures: 0,
        failureLoopEmitted: false,
        lastFailedTool: '',
        lastFailedError: '',
        contextThresholdsHit: new Set(),
        spawnCountThisTurn: 0,
        lastOutputTs: Date.now(),
        stuckTimer: null,
        isExecutingTool: false,
        activeToolUses: new Map(),
        currentToolBlockId: null,
        sessionCostUsd: 0,
        budgetThresholdsHit: new Set(),
      };
      this.agentStates.set(agentId, state);
    }
    return state;
  }

  // ── Private: Detection logic ──

  private checkContextPressure(agentId: string, state: AgentState, event: StreamMessageStart): void {
    const usage = event.message?.usage;
    if (!usage) return;

    const inputTokens = (usage as Record<string, number>).input_tokens ?? 0;
    const cacheRead = (usage as Record<string, number>).cache_read_input_tokens ?? 0;
    const cacheCreation = (usage as Record<string, number>).cache_creation_input_tokens ?? 0;
    const totalTokens = inputTokens + cacheRead + cacheCreation;
    const percent = Math.round((totalTokens / CONTEXT_WINDOW_TOKENS) * 100);

    for (const threshold of CONTEXT_THRESHOLDS) {
      if (percent >= threshold && !state.contextThresholdsHit.has(threshold)) {
        state.contextThresholdsHit.add(threshold);
        this.emit(agentId, {
          type: 'event',
          event: 'context_pressure',
          agentId,
          percent: threshold,
          tokens: totalTokens,
        });
      }
    }
  }

  private detectBuildResult(agentId: string, command: string, output: string): void {
    const exitCode = this.extractExitCode(output);
    const passed = exitCode === 0;
    const errorCount = (output.match(/\berror\b/gi) || []).length;
    const summary = passed
      ? `Build/test passed${errorCount > 0 ? ` (${errorCount} error mentions)` : ''}`
      : `Build/test failed: ${errorCount} error${errorCount !== 1 ? 's' : ''}`;

    this.emit(agentId, {
      type: 'event',
      event: 'build_result',
      agentId,
      command: command.length > 100 ? command.slice(0, 100) + '…' : command,
      passed,
      errors: errorCount,
      summary,
    });
  }

  private detectGitCommit(agentId: string, output: string): void {
    // Extract commit message from git output
    // Typical: [branch abc1234] commit message here
    const match = output.match(/\[[\w/.-]+\s+[a-f0-9]+\]\s+(.+)/);
    const message = match?.[1]?.trim() || this.extractFirstMeaningfulLine(output);

    if (message) {
      this.emit(agentId, {
        type: 'event',
        event: 'git_commit',
        agentId,
        message,
      });
    }
  }

  private detectTaskMilestone(agentId: string, toolName: string, inputJson: string): void {
    if (toolName !== 'TodoWrite') return;

    try {
      const input = JSON.parse(inputJson);
      const todos = input.todos;
      if (!Array.isArray(todos)) return;

      // Count completed vs total
      let completed = 0;
      let total = todos.length;
      let currentTask = '';
      let currentStatus = '';

      for (const todo of todos) {
        if (todo.status === 'completed') completed++;
        // Find the most recently changed task (last in-progress or completed)
        if (todo.status === 'in_progress' || todo.status === 'completed') {
          currentTask = todo.content || todo.task || todo.description || '';
          currentStatus = todo.status;
        }
      }

      if (!currentTask && todos.length > 0) {
        // Fallback: use first todo
        const first = todos[0];
        currentTask = first.content || first.task || first.description || '';
        currentStatus = first.status || 'unknown';
      }

      const progress = `${completed}/${total}`;

      this.emit(agentId, {
        type: 'event',
        event: 'task_milestone',
        agentId,
        task: currentTask.length > 100 ? currentTask.slice(0, 100) + '…' : currentTask,
        status: currentStatus,
        progress,
      });
    } catch {
      // Invalid JSON — skip
    }
  }

  // ── Private: Stuck detection ──

  private touchActivity(agentId: string, state: AgentState): void {
    state.lastOutputTs = Date.now();
    this.resetStuckTimer(agentId, state);
  }

  private resetStuckTimer(agentId: string, state: AgentState): void {
    if (state.stuckTimer) {
      clearTimeout(state.stuckTimer);
    }
    state.stuckTimer = setTimeout(() => {
      this.checkStuck(agentId);
    }, this.stuckTimeoutMs);
  }

  private checkStuck(agentId: string): void {
    const state = this.agentStates.get(agentId);
    if (!state) return;

    // Don't fire during tool execution
    if (state.isExecutingTool) {
      // Re-schedule — check again after timeout
      this.resetStuckTimer(agentId, state);
      return;
    }

    const silentMs = Date.now() - state.lastOutputTs;
    if (silentMs >= this.stuckTimeoutMs) {
      this.emit(agentId, {
        type: 'event',
        event: 'stuck',
        agentId,
        silentMs,
        lastActivity: new Date(state.lastOutputTs).toISOString(),
      });
      // Don't re-emit continuously — one stuck event per silence period
      // Timer will re-arm on next activity
    }
  }

  // ── Private: Helpers ──

  private emit(agentId: string, event: HighSignalEvent): void {
    const emoji = this.eventEmoji(event.event);
    const summary = this.eventSummary(event);

    // Attach for consumers (e.g. native supervisor queue)
    event.emoji = emoji;
    event.summary = summary;

    this.callbacks.pushEventBuffer(agentId, {
      ts: Date.now(),
      type: 'system',
      text: `${emoji} ${summary}`,
    });

    this.callbacks.emitSupervisorEvent(event);
  }

  private eventEmoji(event: string): string {
    switch (event) {
      case 'build_result': return '🔨';
      case 'git_commit': return '📝';
      case 'context_pressure': return '🧠';
      case 'subagent_spawn': return '🔄';
      case 'failure_loop': return '🔁';
      case 'task_milestone': return '📋';
      case 'stuck': return '⚠️';
      case 'budget_alert': return '💰';
      default: return '📡';
    }
  }

  private eventSummary(event: HighSignalEvent): string {
    switch (event.event) {
      case 'build_result':
        return event.passed ? `Build passed ✅` : `Build failed: ${event.errors} errors`;
      case 'git_commit':
        return `Committed: "${event.message}"`;
      case 'context_pressure':
        return `Context at ${event.percent}%`;
      case 'subagent_spawn':
        return event.label
          ? `Spawned: "${event.label}"`
          : `Spawned sub-agent (${event.toolName})`;
      case 'failure_loop':
        return `${event.consecutiveFailures} consecutive failures — possibly stuck`;
      case 'task_milestone':
        return `[${event.progress}] ${event.task} (${event.status})`;
      case 'stuck':
        return `No output for ${Math.round((event.silentMs as number) / 60000)}min`;
      case 'budget_alert':
        return `Session cost reached $${event.threshold} (current: $${(event.currentCost as number).toFixed(2)})`;
      default:
        return event.event;
    }
  }

  private extractTaskLabel(inputJson: string): string {
    try {
      const input = JSON.parse(inputJson);
      const raw = input.description || input.prompt || input.task || input.name || '';
      const label = String(raw).trim().split('\n')[0].trim();
      return label.length > 80 ? label.slice(0, 80) + '…' : label;
    } catch {
      return '';
    }
  }

  private extractCommand(inputJson: string): string | null {
    try {
      const input = JSON.parse(inputJson);
      return input.command || input.cmd || null;
    } catch {
      return null;
    }
  }

  private extractExitCode(output: string): number {
    // CC tool results for Bash typically end with exit code info
    // or the output itself indicates success/failure
    if (/exit code[:\s]+0\b/i.test(output)) return 0;
    if (/exit code[:\s]+(\d+)/i.test(output)) {
      const match = output.match(/exit code[:\s]+(\d+)/i);
      return match ? parseInt(match[1], 10) : 1;
    }
    // If no explicit exit code, check for common failure patterns
    if (/\berror\b.*\bfailed\b/i.test(output) || /\bfailed\b/i.test(output.slice(-200))) {
      return 1;
    }
    // Default: assume success if no obvious failure indicators
    return 0;
  }

  private hasNonZeroExit(content: string): boolean {
    // Check for explicit non-zero exit codes in Bash output
    const match = content.match(/exit code[:\s]+(\d+)/i);
    if (match) return parseInt(match[1], 10) !== 0;
    return false;
  }

  private extractFirstMeaningfulLine(output: string): string {
    const lines = output.split('\n').filter(l => l.trim().length > 0);
    return lines[0]?.trim() || '';
  }
}
