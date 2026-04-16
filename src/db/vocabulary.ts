import db from "./database.js";
import { sm2, type SRCard } from "../curriculum/sr.js";

export interface VocabEntry {
  id: number;
  word: string;
  translation: string | null;
  context: string | null;
  mode: string | null;
  category: string | null;
  lang: string;
  ease_factor: number;
  interval_days: number;
  repetitions: number;
  next_review: string;
  last_score: number;
  created_at: string;
  updated_at: string;
}

const stmts = {
  upsert: db.prepare(`
    INSERT INTO vocabulary (word, translation, context, mode, category, lang)
    VALUES (@word, @translation, @context, @mode, @category, @lang)
    ON CONFLICT(word, lang) DO UPDATE SET
      translation = COALESCE(@translation, translation),
      context = COALESCE(@context, context),
      updated_at = datetime('now')
    RETURNING id
  `),

  getDue: db.prepare(`
    SELECT * FROM vocabulary
    WHERE lang = ? AND next_review <= date('now')
    ORDER BY next_review ASC
    LIMIT ?
  `),

  getByLang: db.prepare(`
    SELECT * FROM vocabulary WHERE lang = ? ORDER BY created_at DESC LIMIT ?
  `),

  getById: db.prepare(`SELECT * FROM vocabulary WHERE id = ?`),

  updateSR: db.prepare(`
    UPDATE vocabulary
    SET ease_factor = @ease_factor,
        interval_days = @interval_days,
        repetitions = @repetitions,
        next_review = @next_review,
        last_score = @last_score,
        updated_at = datetime('now')
    WHERE id = @id
  `),

  countByLang: db.prepare(`SELECT COUNT(*) as count FROM vocabulary WHERE lang = ?`),

  countMastered: db.prepare(`
    SELECT COUNT(*) as count FROM vocabulary
    WHERE lang = ? AND repetitions >= 5
  `),
};

export function addVocab(
  word: string,
  lang: string,
  translation?: string,
  context?: string,
  mode?: string,
  category?: string
): number {
  const row = stmts.upsert.get({
    word, lang,
    translation: translation || null,
    context: context || null,
    mode: mode || null,
    category: category || null,
  }) as { id: number };
  return row.id;
}

export function getDueVocab(lang: string, limit = 10): VocabEntry[] {
  return stmts.getDue.all(lang, limit) as VocabEntry[];
}

export function getRecentVocab(lang: string, limit = 20): VocabEntry[] {
  return stmts.getByLang.all(lang, limit) as VocabEntry[];
}

export function reviewVocab(id: number, score: number): void {
  const entry = stmts.getById.get(id) as VocabEntry | undefined;
  if (!entry) return;

  const card: SRCard = {
    ease_factor: entry.ease_factor,
    interval_days: entry.interval_days,
    repetitions: entry.repetitions,
  };

  const result = sm2(card, score);

  stmts.updateSR.run({
    id,
    ease_factor: result.ease_factor,
    interval_days: result.interval_days,
    repetitions: result.repetitions,
    next_review: result.next_review,
    last_score: score,
  });
}

export function getVocabStats(lang: string): { total: number; mastered: number; due: number } {
  const total = (stmts.countByLang.get(lang) as { count: number }).count;
  const mastered = (stmts.countMastered.get(lang) as { count: number }).count;
  const due = getDueVocab(lang, 999).length;
  return { total, mastered, due };
}
