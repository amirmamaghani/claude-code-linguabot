# LinguaBot

Voice-to-voice language learning bot for Telegram. Send a voice message or text in your native language, get back a teaching response with streaming text and spoken audio in your target language.

Uses Claude Code CLI as the AI brain, Whisper for speech-to-text, and Kokoro/gTTS for text-to-speech. Responses stream to Telegram in real-time via `sendMessageDraft`.

## How it works

```
You (voice/text) -> Telegram -> grammY -> Whisper (STT) -> Claude Code CLI -> streaming text + Kokoro/gTTS (TTS) -> Telegram
```

Single-user, single-container. No database. In-memory state resets on restart. Claude maintains conversation context via `--resume` sessions.

## Modes

- **Tutor** -- Conversational teaching with corrections, vocabulary, and mini-challenges
- **Translator** -- Describe what you want to say, get the natural phrase with pronunciation
- **Drills** -- Practice phrases by category with scoring

## Quick start (local)

Requires: Node.js 20+, Python 3, ffmpeg, authenticated `claude` CLI.

```bash
git clone <repo> && cd linguabot
cp .env.example .env
# Edit .env: set TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID, TARGET_LANG, NATIVE_LANG

npm install
pip3 install gtts  # for TTS fallback

npx tsx src/bot.ts
```

The Whisper model downloads automatically on first voice message (~150MB for `base`).

## Quick start (Docker)

Requires: Docker, `ANTHROPIC_API_KEY` (OAuth tokens don't work in containers).

```bash
cp .env.example .env
# Edit .env: set TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID, ANTHROPIC_API_KEY

docker compose up -d --build
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `TELEGRAM_BOT_TOKEN` | Yes | -- | From [@BotFather](https://t.me/BotFather) |
| `TELEGRAM_USER_ID` | Yes | -- | Your numeric Telegram ID ([@userinfobot](https://t.me/userinfobot)) |
| `ANTHROPIC_API_KEY` | Docker only | -- | API key from console.anthropic.com |
| `TARGET_LANG` | No | `es` | Language to learn (ISO 639-1) |
| `NATIVE_LANG` | No | `en` | Your native language (ISO 639-1) |
| `WHISPER_MODEL` | No | `base` | Whisper model: tiny, base, small, medium, large |

## Telegram commands

```
/start   -- Show current settings
/mode    -- Switch: Tutor, Translator, Drills
/lang    -- Change target language (24 languages)
/native  -- Change native language
/level   -- Beginner / Intermediate / Advanced
/voice   -- Toggle voice replies on/off
/drills  -- Pick drill category
/reset   -- Clear conversation context
/help    -- Show all commands
```

## TTS engine selection

Kokoro (high quality, local) is used when available for the target language. Everything else falls back to gTTS (Google).

| Language | Engine |
|----------|--------|
| English, Spanish, French, Japanese, Chinese, Hindi, Italian, Portuguese | Kokoro |
| German, Russian, Korean, Czech, and 15 others | gTTS |

## Project structure

```
src/
  bot.ts              -- Entry point, Telegram handlers, commands, state, config
  claude-bridge.ts    -- Spawns claude -p with streaming JSON output
  prompts.ts          -- System prompt templates per mode
  stt.ts              -- Whisper transcription + ogg-to-wav
  tts.ts              -- Kokoro/gTTS routing + audio conversion
python/
  tts_kokoro.py       -- Kokoro TTS CLI script
  tts_gtts.py         -- gTTS fallback CLI script
```

## Architecture decisions

- **Claude Code CLI over API**: Uses `claude -p --output-format stream-json` as a subprocess. No API key management needed for local use -- inherits your authenticated CLI session. Streaming JSON events are parsed and piped to Telegram's `sendMessageDraft` for real-time response display.
- **5 source files instead of 12**: State, config, types, text processing, and audio conversion are inlined into their sole consumers. Each remaining file represents a genuinely distinct concern.
- **Owner-only access**: `TELEGRAM_USER_ID` middleware silently ignores all other users. No multi-user complexity.
- **grammY Stream plugin**: Responses appear progressively via Telegram's draft message API, similar to how ChatGPT streams responses.

## Local development

```bash
npm run dev    # tsx watch with auto-reload
npm run build  # tsup production build
npm start      # run production build
```
