# Progress Tracking & Lesson System Design

## Overview

Add persistent progress tracking and structured lesson system to LinguaBot. Uses SQLite for persistence, YAML curriculum files, and SM-2 spaced repetition.

## Architecture

```
Existing: bot.ts → prompts.ts → claude-bridge.ts
                                    ↓
New:      db/database.ts ← SQLite (better-sqlite3)
          db/vocabulary.ts ← vocab CRUD + spaced repetition
          db/lessons.ts ← lesson state management
          db/stats.ts ← daily stats
          curriculum/loader.ts ← YAML curriculum reader
          curriculum/sr.ts ← SM-2 algorithm
          data/curriculum/ru/A1/*.yaml ← lesson content
```

## Database Schema (SQLite)

- **vocabulary**: words with SM-2 fields (ease_factor, interval, repetitions, next_review)
- **lessons**: curriculum entries with status (locked/available/in_progress/completed)
- **daily_stats**: per-day activity metrics
- **session_log**: what Claude taught in each session

## Lesson Structure

CEFR-aligned modules (A1→B2), each with ordered lessons. Lessons have phases that map to existing modes (tutor → drills → tutor roleplay). Unlock requires previous lesson score >= 70%.

## Mode Integration

Prompts gain lesson context injection: current lesson objectives, vocabulary to teach/review, due spaced-repetition words. Modes stay as-is but receive richer system prompts.

## New Commands

- `/progress` — dashboard
- `/lesson` — current lesson / continue
- `/lessons` — module list with status
- `/vocab` — due vocabulary
- `/review` — spaced repetition session
- `/stats` — weekly stats

## Tech

- better-sqlite3 (sync, zero-config)
- js-yaml for curriculum files
- SM-2 algorithm (~30 LOC)
- Docker volume for SQLite file persistence
