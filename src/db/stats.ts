import db from "./database.js";

function today(): string {
  return new Date().toISOString().split("T")[0];
}

const stmts = {
  ensureToday: db.prepare(`
    INSERT OR IGNORE INTO daily_stats (date) VALUES (?)
  `),

  increment: db.prepare(`
    UPDATE daily_stats SET messages_sent = messages_sent + 1 WHERE date = ?
  `),

  addVocabReviewed: db.prepare(`
    UPDATE daily_stats SET vocab_reviewed = vocab_reviewed + ? WHERE date = ?
  `),

  addVocabLearned: db.prepare(`
    UPDATE daily_stats SET vocab_learned = vocab_learned + ? WHERE date = ?
  `),

  addDrill: db.prepare(`
    UPDATE daily_stats SET drills_completed = drills_completed + 1 WHERE date = ?
  `),

  setDrillAccuracy: db.prepare(`
    UPDATE daily_stats SET drill_accuracy = ? WHERE date = ?
  `),

  addMode: db.prepare(`
    UPDATE daily_stats SET modes_used = ? WHERE date = ?
  `),

  getToday: db.prepare(`SELECT * FROM daily_stats WHERE date = ?`),

  getRange: db.prepare(`
    SELECT * FROM daily_stats WHERE date BETWEEN ? AND ? ORDER BY date DESC
  `),

  getStreak: db.prepare(`
    SELECT date FROM daily_stats
    WHERE messages_sent > 0
    ORDER BY date DESC
  `),
};

export interface DayStats {
  date: string;
  messages_sent: number;
  vocab_reviewed: number;
  vocab_learned: number;
  drills_completed: number;
  drill_accuracy: number | null;
  minutes_active: number;
  modes_used: string;
}

function ensureToday(): void {
  stmts.ensureToday.run(today());
}

export function trackMessage(): void {
  ensureToday();
  stmts.increment.run(today());
}

export function trackVocabReviewed(count: number): void {
  ensureToday();
  stmts.addVocabReviewed.run(count, today());
}

export function trackVocabLearned(count: number): void {
  ensureToday();
  stmts.addVocabLearned.run(count, today());
}

export function trackDrill(): void {
  ensureToday();
  stmts.addDrill.run(today());
}

export function trackMode(mode: string): void {
  ensureToday();
  const row = stmts.getToday.get(today()) as DayStats | undefined;
  if (!row) return;
  const modes: string[] = JSON.parse(row.modes_used || "[]");
  if (!modes.includes(mode)) {
    modes.push(mode);
    stmts.addMode.run(JSON.stringify(modes), today());
  }
}

export function getTodayStats(): DayStats | null {
  ensureToday();
  return (stmts.getToday.get(today()) as DayStats) || null;
}

export function getWeekStats(): DayStats[] {
  const end = today();
  const start = new Date();
  start.setDate(start.getDate() - 6);
  return stmts.getRange.all(start.toISOString().split("T")[0], end) as DayStats[];
}

export function getStreak(): number {
  const rows = stmts.getStreak.all() as { date: string }[];
  if (rows.length === 0) return 0;

  let streak = 0;
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  for (let i = 0; i < rows.length; i++) {
    const expected = new Date(now);
    expected.setDate(expected.getDate() - i);
    const expectedStr = expected.toISOString().split("T")[0];

    if (rows[i].date === expectedStr) {
      streak++;
    } else {
      break;
    }
  }

  return streak;
}
