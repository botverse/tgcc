import type pino from 'pino';

// ── Gemini audio/video transcription ──
//
// Ported from linds.ai-chat/src/services/llm.js:346-382 (transcribeAudio), which is the
// verified-working path — specifically verified on Spanish (linds.ai-chat/_specs/voice-transcription.md:44).
// Provider choice is deliberate: no ffmpeg dependency (Gemini takes audio/video inline), and
// no forced --language, so it works for an EN/ES household. See BACKLOG.md §4 in linds.ai-chat.

export interface TranscribeResult {
  /** True if the transcription call completed successfully (even if the transcript is empty —
   *  i.e. no intelligible speech). False means the call itself failed (missing key, network,
   *  timeout, non-2xx). Callers must distinguish these: `ok: false` is a loud failure,
   *  `ok: true, text: null` is a legitimate "nothing to transcribe" result. */
  ok: boolean;
  text: string | null;
  /** True when Gemini's finishReason was MAX_TOKENS — the transcript was cut off mid-stream. */
  truncated: boolean;
  model: string;
  provider: 'gemini' | 'whisper';
  /** Present when ok === false. */
  error?: string;
}

export const DEFAULT_TRANSCRIBE_MODEL = 'gemini-2.5-flash';
export const TRANSCRIBE_TIMEOUT_MS = 30_000;
// ~10-12 min of speech per linds.ai-chat/_specs/BACKLOG.md §3 (was 2048 there, which is why
// long dictated notes were getting silently cut off).
export const TRANSCRIBE_MAX_OUTPUT_TOKENS = 8192;

const TRANSCRIBE_PROMPT =
  'Transcribe this voice message verbatim in its original language. Output ONLY the transcription ' +
  'text — no preamble, no translation, no commentary. If there is no intelligible speech, output an empty string.';

function resolveApiKey(): string | undefined {
  return process.env.AISTUDIO_API_KEY || process.env.VERTEX_AI_KEY;
}

/**
 * Transcribe an audio or video clip via Gemini (AI Studio). `mimeType` may be any inline_data
 * mime type Gemini accepts (e.g. "audio/ogg", "audio/mpeg", "video/mp4") — the same call path
 * is reused for voice notes, forwarded audio files, and video notes (Gemini reads the audio
 * track directly, no ffmpeg extraction needed).
 *
 * Never throws — every failure mode (no key, network error, non-2xx, timeout) is captured in
 * the returned result so callers can surface it instead of swallowing it.
 */
export async function transcribeAudioGemini(
  base64Data: string,
  mimeType: string,
  logger?: pino.Logger,
): Promise<TranscribeResult> {
  const model = process.env.TRANSCRIBE_MODEL || DEFAULT_TRANSCRIBE_MODEL;
  const key = resolveApiKey();
  if (!key) {
    return {
      ok: false,
      text: null,
      truncated: false,
      model,
      provider: 'gemini',
      error: 'No AISTUDIO_API_KEY/VERTEX_AI_KEY configured',
    };
  }

  // WhatsApp/Telegram opus notes arrive as "audio/ogg; codecs=opus" — strip params for the API.
  const mt = (mimeType || 'audio/ogg').split(';')[0].trim();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TRANSCRIBE_TIMEOUT_MS);
  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { inline_data: { mime_type: mt, data: base64Data } },
              { text: TRANSCRIBE_PROMPT },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: TRANSCRIBE_MAX_OUTPUT_TOKENS, temperature: 0 },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Gemini ${res.status}: ${body.substring(0, 200)}`);
    }

    const j = await res.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
    };
    const candidate = j.candidates?.[0];
    const rawText = candidate?.content?.parts?.[0]?.text;
    const truncated = candidate?.finishReason === 'MAX_TOKENS';

    return {
      ok: true,
      text: rawText && rawText.trim() ? rawText.trim() : null,
      truncated,
      model,
      provider: 'gemini',
    };
  } catch (e) {
    const err = e as Error;
    const reason = err.name === 'AbortError' ? `timed out after ${TRANSCRIBE_TIMEOUT_MS}ms` : err.message;
    logger?.error({ err }, '[Transcribe] Gemini transcription failed');
    return { ok: false, text: null, truncated: false, model, provider: 'gemini', error: reason };
  } finally {
    clearTimeout(timer);
  }
}

// ── Injected-turn formatting ──

/** Format seconds as `m:ss`. Returns `?:??` if duration is unknown. */
export function formatDuration(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '?:??';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export interface BuildTranscriptionTurnOptions {
  /** Sender's display name — only surfaced in the success case, matching the spec example. */
  senderName?: string;
  durationSec?: number;
  filePath: string;
  /** e.g. "Voice note", "Audio", "Video note". */
  kind: string;
  result: TranscribeResult;
}

/**
 * Build the text injected into the CC turn for a transcribed voice note / audio file / video
 * note. Three shapes, matching linds.ai-chat/_specs/BACKLOG.md §4a/4c/4d exactly:
 *  - transcription failed outright → loud FAILED line (never silent — this is the whole point
 *    of the fix: a broken dependency must not be presented as a missing feature)
 *  - transcription succeeded but there was no intelligible speech → explicit "no speech" line
 *  - transcription succeeded with text → quoted transcript, provenance, and the audio path
 * The file path is always kept in the text (cheap insurance, exactly what enables manual
 * recovery) even though /tmp doesn't survive a reboot.
 */
export function buildTranscriptionTurn(opts: BuildTranscriptionTurnOptions): string {
  const { senderName, durationSec, filePath, kind, result } = opts;
  const durStr = formatDuration(durationSec);

  if (!result.ok) {
    return `[${kind} — transcription FAILED: ${result.error ?? 'unknown error'}. Audio at ${filePath}; you may transcribe it yourself.]`;
  }

  if (!result.text) {
    return `[${kind}, ${durStr} — no intelligible speech detected]\n\n[Audio file: ${filePath}]`;
  }

  const who = senderName ? ` from ${senderName}` : '';
  const truncationNote = result.truncated ? `\n\n[transcript truncated — full audio at ${filePath}]` : '';
  return `[${kind}${who} — ${durStr}, transcribed by ${result.model}]\n"${result.text}"${truncationNote}\n\n[Audio file: ${filePath}]`;
}
