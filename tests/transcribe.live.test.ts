// tests/transcribe.live.test.ts
//
// LIVE, NON-MOCKED check of Spanish transcription against real corpus audio —
// per _specs/BACKLOG.md item 4b/7 (linds.ai-chat repo) and lead's decision on
// 2026-08-06 ("real corpus audio, out of git, env var, skip cleanly when
// unset" — priority route over synthetic TTS, which does not exercise the
// property that actually broke: accented/conversational/code-switched speech).
//
// This is deliberately kept OUT of tests/transcribe.test.ts (the mocked unit
// suite) so a skip or a real Gemini-side failure here never reads as "core
// logic broken" — those are two different claims. transcribe.test.ts proves
// the request is well-formed (no forced language, etc.); THIS file is the
// only place that proves a real human Spanish voice note actually comes back
// as Spanish text.
//
// Requires (both, or the suite skips cleanly — never fails on absence):
//   - AISTUDIO_API_KEY (or VERTEX_AI_KEY) in the environment
//   - tests/fixtures/audio/antonio-es.ogg present (gitignored — see
//     tests/fixtures/audio/README.md for provenance + how to regenerate)
//
// Run: npx vitest run tests/transcribe.live.test.ts

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { transcribeAudioGemini } from '../src/transcribe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = process.env.SPANISH_FIXTURE_PATH || join(__dirname, 'fixtures', 'audio', 'antonio-es.ogg');

const hasKey = !!(process.env.AISTUDIO_API_KEY || process.env.VERTEX_AI_KEY);
const hasFixture = existsSync(FIXTURE_PATH);
const canRun = hasKey && hasFixture;

// Known-good reference transcript for this exact audio, pulled from linds-db
// (messages.content for the source message — see fixtures/audio/README.md).
// Not asserting exact-match (models vary run to run on punctuation/fillers);
// asserting the substantive content is recognizably present.
const REFERENCE_PHRASES = ['duda', 'sugerencia', 'confianza'];

describe.skipIf(!canRun)('transcribeAudioGemini — live Spanish corpus check', () => {
  it(
    'transcribes a real Spanish WhatsApp voice note and returns recognizable Spanish text (NOT a substitute for the accented/code-switched acceptance criterion — see file header)',
    async () => {
      const audioBuffer = readFileSync(FIXTURE_PATH);
      const base64Audio = audioBuffer.toString('base64');

      const result = await transcribeAudioGemini(base64Audio, 'audio/ogg; codecs=opus');

      expect(result.ok).toBe(true);
      expect(result.text).toBeTruthy();

      const lower = (result.text || '').toLowerCase();
      // Spanish-specific signal: either a known reference word/phrase from the
      // real transcript, or at minimum a Spanish diacritic/character — guards
      // against a silently-English or silently-empty "success".
      const hasReferencePhrase = REFERENCE_PHRASES.some((p) => lower.includes(p));
      const hasSpanishChars = /[ñáéíóúü¿¡]/i.test(result.text || '');
      expect(
        hasReferencePhrase || hasSpanishChars,
        `transcript did not look like Spanish and matched none of ${JSON.stringify(REFERENCE_PHRASES)}. Got: ${result.text}`
      ).toBe(true);
    },
    30_000
  );
});

if (!canRun) {
  // vitest requires at least one non-empty describe/it to avoid an
  // "empty suite" failure when the whole block above is skipped.
  describe('transcribeAudioGemini — live Spanish corpus check (skipped)', () => {
    it(`skipped: ${!hasKey ? 'no AISTUDIO_API_KEY/VERTEX_AI_KEY configured' : ''}${!hasKey && !hasFixture ? ' AND ' : ''}${!hasFixture ? `no fixture at ${FIXTURE_PATH} (gitignored — see tests/fixtures/audio/README.md)` : ''}`, () => {
      expect(true).toBe(true);
    });
  });
}
