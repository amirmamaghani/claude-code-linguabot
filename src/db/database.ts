import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "fs";
import { dirname } from "path";

const DB_PATH = process.env.DB_PATH || "./db/linguabot.db";

// Ensure data directory exists
const dir = dirname(DB_PATH);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

const db = new Database(DB_PATH);

// Performance settings
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// Run migrations
db.exec(`
  CREATE TABLE IF NOT EXISTS vocabulary (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word TEXT NOT NULL,
    translation TEXT,
    context TEXT,
    mode TEXT,
    category TEXT,
    lang TEXT NOT NULL,
    ease_factor REAL DEFAULT 2.5,
    interval_days INTEGER DEFAULT 1,
    repetitions INTEGER DEFAULT 0,
    next_review TEXT DEFAULT (date('now')),
    last_score INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    UNIQUE(word, lang)
  );

  CREATE TABLE IF NOT EXISTS lessons (
    id TEXT PRIMARY KEY,
    lang TEXT NOT NULL,
    module TEXT NOT NULL,
    level TEXT NOT NULL,
    title TEXT NOT NULL,
    title_native TEXT,
    description TEXT,
    objectives TEXT,
    order_index INTEGER NOT NULL,
    status TEXT DEFAULT 'locked' CHECK(status IN ('locked','available','in_progress','completed')),
    score INTEGER,
    completed_at TEXT,
    current_phase INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS daily_stats (
    date TEXT PRIMARY KEY,
    messages_sent INTEGER DEFAULT 0,
    vocab_reviewed INTEGER DEFAULT 0,
    vocab_learned INTEGER DEFAULT 0,
    drills_completed INTEGER DEFAULT 0,
    drill_accuracy REAL,
    minutes_active INTEGER DEFAULT 0,
    modes_used TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS session_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    claude_session_id TEXT,
    mode TEXT,
    category TEXT,
    lesson_id TEXT,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    vocab_introduced TEXT DEFAULT '[]',
    summary TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_vocab_next_review ON vocabulary(next_review);
  CREATE INDEX IF NOT EXISTS idx_vocab_lang ON vocabulary(lang);
  CREATE INDEX IF NOT EXISTS idx_lessons_lang_level ON lessons(lang, level);
  CREATE INDEX IF NOT EXISTS idx_lessons_status ON lessons(status);
`);

export default db;
