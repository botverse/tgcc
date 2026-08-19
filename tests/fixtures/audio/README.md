# Audio fixtures (gitignored)

This directory holds real audio used for a live, non-mocked check of Spanish
transcription (`tests/transcribe.live.test.ts`). The audio files themselves are
gitignored — this README is the only tracked file here.

## `antonio-es.ogg`

- **Source:** a real WhatsApp voice note from Antonio Gassó, copied from
  `/data/whatsapp-media/Message/Media/34619708054@s.whatsapp.net/3a/3A63DC5B81833266D4A9.bin`
  on the linds.ai-chat host (message id `5418a1e3-0e68-4ef0-9e24-e76d4a030c4d`,
  2026-06-25). Same source used by the original acceptance test recorded in
  `linds.ai-chat/_specs/voice-transcription.md:44` ("`transcribeAudio` on the
  Antonio `.ogg` returns Spanish text").
- **Format:** Ogg/Opus, mono, 48kHz — despite the `.bin` name on disk
  (WhatsApp's raw storage naming), confirmed via `file(1)`.
- **Why this file and not synthetic TTS:** this is real, conversational,
  accented Spanish with natural hesitations ("eh") — the actual property that
  broke (Whisper's failure mode was accented/conversational/code-switched
  speech, not clean audio). A synthetic TTS sample would not exercise that.
- **Known reference transcript** (from linds-db `messages.content`, already
  human-verified via the production transcription pipeline this was ported
  from — not a guess):
  > "Cualquier duda que tengas o sugerencia eh decírmelo, eh, en confianza. No,
  > no hay ningún tipo de problema."
- **Regenerating this fixture:** if it's ever lost, any short (~15-30s) `ptt`
  voice note from linds-db's `attachments` table works — join `messages` for
  the known-good `content` (transcript) to use as the reference. See
  `tests/transcribe.live.test.ts` for the exact query pattern used to find it.
- **This is real personal audio — never commit the actual file.** Do not
  remove the `.gitignore` rule for this directory.
