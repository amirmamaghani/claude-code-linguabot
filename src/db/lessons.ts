import db from "./database.js";

export interface LessonRow {
  id: string;
  lang: string;
  module: string;
  level: string;
  title: string;
  title_native: string | null;
  description: string | null;
  objectives: string; // JSON array
  order_index: number;
  status: "locked" | "available" | "in_progress" | "completed";
  score: number | null;
  completed_at: string | null;
  current_phase: number;
}

const stmts = {
  upsert: db.prepare(`
    INSERT INTO lessons (id, lang, module, level, title, title_native, description, objectives, order_index)
    VALUES (@id, @lang, @module, @level, @title, @title_native, @description, @objectives, @order_index)
    ON CONFLICT(id) DO UPDATE SET
      title = @title,
      title_native = @title_native,
      description = @description,
      objectives = @objectives,
      order_index = @order_index
  `),

  getByLang: db.prepare(`
    SELECT * FROM lessons WHERE lang = ? ORDER BY order_index ASC
  `),

  getByLangLevel: db.prepare(`
    SELECT * FROM lessons WHERE lang = ? AND level = ? ORDER BY order_index ASC
  `),

  getById: db.prepare(`SELECT * FROM lessons WHERE id = ?`),

  getCurrent: db.prepare(`
    SELECT * FROM lessons
    WHERE lang = ? AND status IN ('available', 'in_progress')
    ORDER BY order_index ASC
    LIMIT 1
  `),

  setStatus: db.prepare(`
    UPDATE lessons SET status = @status WHERE id = @id
  `),

  complete: db.prepare(`
    UPDATE lessons
    SET status = 'completed', score = @score, completed_at = datetime('now')
    WHERE id = @id
  `),

  setPhase: db.prepare(`
    UPDATE lessons SET current_phase = ?, status = 'in_progress' WHERE id = ?
  `),

  getNext: db.prepare(`
    SELECT * FROM lessons
    WHERE lang = ? AND order_index > ?
    ORDER BY order_index ASC
    LIMIT 1
  `),

  countByStatus: db.prepare(`
    SELECT status, COUNT(*) as count FROM lessons
    WHERE lang = ?
    GROUP BY status
  `),
};

export function upsertLesson(lesson: {
  id: string;
  lang: string;
  module: string;
  level: string;
  title: string;
  title_native?: string;
  description?: string;
  objectives: string[];
  order_index: number;
}): void {
  stmts.upsert.run({
    ...lesson,
    title_native: lesson.title_native || null,
    description: lesson.description || null,
    objectives: JSON.stringify(lesson.objectives),
  });
}

export function getLessons(lang: string): LessonRow[] {
  return stmts.getByLang.all(lang) as LessonRow[];
}

export function getLessonsByLevel(lang: string, level: string): LessonRow[] {
  return stmts.getByLangLevel.all(lang, level) as LessonRow[];
}

export function getLesson(id: string): LessonRow | null {
  return (stmts.getById.get(id) as LessonRow) || null;
}

export function getCurrentLesson(lang: string): LessonRow | null {
  return (stmts.getCurrent.get(lang) as LessonRow) || null;
}

export function startLesson(id: string): void {
  stmts.setStatus.run({ id, status: "in_progress" });
}

export function advancePhase(id: string, phase: number): void {
  stmts.setPhase.run(phase, id);
}

export function completeLesson(id: string, score: number): void {
  stmts.complete.run({ id, score });

  // Unlock next lesson if score >= 70
  const lesson = getLesson(id);
  if (!lesson || score < 70) return;

  const next = stmts.getNext.get(lesson.lang, lesson.order_index) as LessonRow | undefined;
  if (next && next.status === "locked") {
    stmts.setStatus.run({ id: next.id, status: "available" });
  }
}

export function getLessonStats(lang: string): Record<string, number> {
  const rows = stmts.countByStatus.all(lang) as { status: string; count: number }[];
  const result: Record<string, number> = { locked: 0, available: 0, in_progress: 0, completed: 0 };
  for (const row of rows) result[row.status] = row.count;
  return result;
}
