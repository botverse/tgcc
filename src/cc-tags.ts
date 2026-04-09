// ── CC Protocol XML Tags ──
//
// Claude Code uses XML tags to distinguish message types in the conversation.
// These helpers ensure TGCC messages are properly tagged so CC's model can
// distinguish system events from agent-to-agent messages from user input.

/**
 * Wrap text in <system-reminder> — used for system context, events, and notifications.
 * CC's system prompt tells the model these are "automatically added by the system".
 */
export function wrapSystemReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`;
}

/**
 * Wrap text in <teammate-message> — used for agent-to-agent communication.
 * Mirrors CC's own format from useInboxPoller / teammateMailbox.
 */
export function wrapTeammateMessage(from: string, content: string, summary?: string): string {
  const summaryAttr = summary ? ` summary="${escapeAttr(summary)}"` : '';
  return `<teammate-message teammate_id="${escapeAttr(from)}"${summaryAttr}>\n${content}\n</teammate-message>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
