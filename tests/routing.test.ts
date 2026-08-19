// tests/routing.test.ts
//
// Tests for the two pure seams tgcc-dev extracted from Bridge for BACKLOG.md
// item 4d (linds.ai-chat repo): group voice notes losing sender attribution/
// reply-context, and voice notes not coalescing with a fast follow-up text.
// Both `buildInboundText` and `MessageBatcher` are pure/exported specifically
// so this doesn't need to instantiate a full Bridge (per tgcc-dev's message,
// 2026-08-06).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { buildInboundText, MessageBatcher, type BatcherOutput } from '../src/bridge.js';

// ── buildInboundText ──
//
// The regression this covers: transcribed voice/audio/video_note text used to
// bypass reply-context and group attribution entirely (bridge.ts:1128's early
// return skipped straight to sendToCC). Now everything — text or transcript —
// goes through this same function, so a voice note in a group must come out
// attributed exactly like a text message would.

describe('buildInboundText', () => {
  it('DM, no reply, no attribution: text passes through unchanged', () => {
    const out = buildInboundText({ text: 'hello', chatId: 123 }, null, undefined);
    expect(out).toBe('hello');
  });

  it('DM with a reply: prepends the reply-context line, no group attribution', () => {
    const out = buildInboundText({ text: 'hello', chatId: 123, replyToText: 'earlier' }, null, undefined);
    expect(out).toBe("[Replying to: 'earlier']\n\nhello");
  });

  it('group chat (negative chatId) with a userName: prepends [Name]: ', () => {
    const out = buildInboundText({ text: 'hello', chatId: -100, userName: 'Fnz' }, null, undefined);
    expect(out).toBe('[Fnz]: hello');
  });

  it('group chat with userName + userHandle: prepends [Name (@handle)]: ', () => {
    const out = buildInboundText({ text: 'hello', chatId: -100, userName: 'Fnz', userHandle: 'fnz' }, null, undefined);
    expect(out).toBe('[Fnz (@fnz)]: hello');
  });

  it('group chat WITHOUT a userName does not attribute, even though chatId is negative (matches DM behavior — no sender info to attach)', () => {
    const out = buildInboundText({ text: 'hello', chatId: -100 }, 'ROSTER', 'CTX');
    expect(out).toBe('hello');
  });

  it('group chat with a roster: wraps it as a system-reminder ahead of the attributed text', () => {
    const out = buildInboundText({ text: 'hello', chatId: -100, userName: 'Fnz' }, 'ROSTER_TEXT', undefined);
    expect(out).toBe('<system-reminder>\nROSTER_TEXT\n</system-reminder>\n[Fnz]: hello');
  });

  it('group chat with groupContext (no roster): also wraps as a system-reminder', () => {
    const out = buildInboundText({ text: 'hello', chatId: -100, userName: 'Fnz' }, null, 'CTX_TEXT');
    expect(out).toBe('<system-reminder>\nCTX_TEXT\n</system-reminder>\n[Fnz]: hello');
  });

  it('group chat with BOTH roster and groupContext: joined by a blank line inside one system-reminder', () => {
    const out = buildInboundText({ text: 'hello', chatId: -100, userName: 'Fnz' }, 'ROSTER_TEXT', 'CTX_TEXT');
    expect(out).toBe('<system-reminder>\nROSTER_TEXT\n\nCTX_TEXT\n</system-reminder>\n[Fnz]: hello');
  });

  it('full combo (group + reply + handle + roster + groupContext): reply-context nests inside the attribution tag, which nests inside the system-reminder', () => {
    // This is the exact shape a transcribed voice note in a group, replying to
    // another message, must now produce — previously all of this was dropped.
    const out = buildInboundText(
      { text: 'hello', replyToText: 'earlier msg', chatId: -100, userName: 'Fnz', userHandle: 'fnz' },
      'ROSTER_TEXT',
      'GROUP_CONTEXT'
    );
    expect(out).toBe(
      "<system-reminder>\nROSTER_TEXT\n\nGROUP_CONTEXT\n</system-reminder>\n[Fnz (@fnz)]: [Replying to: 'earlier msg']\n\nhello"
    );
  });

  it('a transcript-shaped input (the actual item-4 use case) still gets full group attribution', () => {
    // Simulates what transcribeMedia now feeds in: no filePath/fileName at
    // this layer (that's a Batcher-level concern, see below) — just text.
    const transcript = '[Voice note from Fonz — 0:14, transcribed by gemini-2.5-flash]\n"¿Puedes mirar lo del backup de anoche?"';
    const out = buildInboundText({ text: transcript, chatId: -555, userName: 'Fonz', userHandle: 'fonz' }, 'ROSTER', undefined);
    expect(out).toContain('<system-reminder>\nROSTER\n</system-reminder>');
    expect(out).toContain('[Fonz (@fonz)]:');
    expect(out).toContain(transcript);
  });
});

// ── MessageBatcher ──
//
// The regression this covers: transcribeVoice() called sendToCC directly,
// bypassing the 2s MessageBatcher window entirely, so a voice note plus an
// immediate follow-up text never coalesced into one turn. Fix: transcribed
// output now goes through the same batcher as text, distinguished from real
// attachments only by the absence of filePath/fileName.

describe('MessageBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('a message WITH filePath/fileName (real attachment) flushes immediately — existing document/photo behavior, unchanged', () => {
    const flushFn = vi.fn();
    const batcher = new MessageBatcher(2000, flushFn);
    batcher.add({ text: '', filePath: '/tmp/doc.pdf', fileName: 'doc.pdf' });
    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(flushFn).toHaveBeenCalledWith({ text: '', filePath: '/tmp/doc.pdf', fileName: 'doc.pdf' });
  });

  it('a message WITHOUT filePath/fileName (what transcribeMedia now produces) does NOT flush immediately — waits for the window', () => {
    const flushFn = vi.fn();
    const batcher = new MessageBatcher(2000, flushFn);
    batcher.add({ text: '[Voice note] "hola"' });
    expect(flushFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1999);
    expect(flushFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(flushFn).toHaveBeenCalledWith({ text: '[Voice note] "hola"' });
  });

  it('a transcript coalesces with a fast follow-up text message within the window — the actual item-4 fix', () => {
    const flushFn = vi.fn();
    const batcher = new MessageBatcher(2000, flushFn);
    batcher.add({ text: '[Voice note] "check the backup"' });
    vi.advanceTimersByTime(500);
    batcher.add({ text: 'also can you do it today' });
    vi.advanceTimersByTime(2000);
    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(flushFn).toHaveBeenCalledWith({ text: '[Voice note] "check the backup"\n\nalso can you do it today' });
  });

  it('a single image (no mediaGroupId) flushes immediately as imageBase64', () => {
    const flushFn = vi.fn();
    const batcher = new MessageBatcher(2000, flushFn);
    batcher.add({ text: 'caption', imageBase64: 'AAA', imageMediaType: 'image/jpeg' });
    expect(flushFn).toHaveBeenCalledTimes(1);
    expect(flushFn).toHaveBeenCalledWith({ text: 'caption', imageBase64: 'AAA', imageMediaType: 'image/jpeg' });
  });

  it('multiple images sharing a mediaGroupId wait ~500ms then flush combined as `images[]`', () => {
    const flushFn = vi.fn();
    const batcher = new MessageBatcher(2000, flushFn);
    batcher.add({ text: '', imageBase64: 'AAA', imageMediaType: 'image/jpeg', mediaGroupId: 'g1' });
    batcher.add({ text: '', imageBase64: 'BBB', imageMediaType: 'image/png', mediaGroupId: 'g1' });
    expect(flushFn).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(flushFn).toHaveBeenCalledTimes(1);
    const out = flushFn.mock.calls[0][0] as BatcherOutput;
    expect(out.images).toHaveLength(2);
    expect(out.images).toEqual([
      { base64: 'AAA', mediaType: 'image/jpeg' },
      { base64: 'BBB', mediaType: 'image/png' },
    ]);
  });

  it('cancel() drops pending messages without flushing', () => {
    const flushFn = vi.fn();
    const batcher = new MessageBatcher(2000, flushFn);
    batcher.add({ text: 'will be dropped' });
    batcher.cancel();
    vi.advanceTimersByTime(5000);
    expect(flushFn).not.toHaveBeenCalled();
  });

  it('destroy() clears timers without flushing', () => {
    const flushFn = vi.fn();
    const batcher = new MessageBatcher(2000, flushFn);
    batcher.add({ text: 'pending at destroy time' });
    batcher.destroy();
    vi.advanceTimersByTime(5000);
    expect(flushFn).not.toHaveBeenCalled();
  });
});
