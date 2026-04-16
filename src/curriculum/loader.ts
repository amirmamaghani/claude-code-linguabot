import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { upsertLesson, getLessons, startLesson } from "../db/lessons.js";

export interface LessonPhase {
  mode: "tutor" | "translator" | "drills";
  category?: string;
  instruction: string;
}

export interface VocabItem {
  word: string;
  pronunciation: string;
  translation: string;
  usage?: string;
}

export interface GrammarItem {
  concept: string;
  explanation: string;
}

export interface PhraseItem {
  native: string;
  target: string;
}

export interface LessonData {
  id: string;
  module: string;
  order: number;
  title: string;
  title_native?: string;
  description?: string;
  objectives: string[];
  vocabulary: VocabItem[];
  grammar: GrammarItem[];
  phrases: PhraseItem[];
  phases: LessonPhase[];
  pass_score: number;
}

// Cache loaded lesson data (YAML content, not DB state)
const lessonCache = new Map<string, LessonData>();

export function loadCurriculum(lang: string): LessonData[] {
  const basePath = join(process.cwd(), "data", "curriculum", lang);
  if (!existsSync(basePath)) return [];

  const lessons: LessonData[] = [];
  const levels = readdirSync(basePath).sort();

  let globalOrder = 0;

  for (const level of levels) {
    const levelPath = join(basePath, level);
    const files = readdirSync(levelPath).filter(f => f.endsWith(".yaml") || f.endsWith(".yml")).sort();

    for (const file of files) {
      const content = readFileSync(join(levelPath, file), "utf-8");
      const data = yaml.load(content) as LessonData;
      data.order = globalOrder++;
      lessons.push(data);
      lessonCache.set(data.id, data);
    }
  }

  return lessons;
}

export function syncCurriculumToDb(lang: string): number {
  const lessons = loadCurriculum(lang);

  for (const lesson of lessons) {
    upsertLesson({
      id: lesson.id,
      lang,
      module: lesson.module,
      level: lesson.module,
      title: lesson.title,
      title_native: lesson.title_native,
      description: lesson.description,
      objectives: lesson.objectives,
      order_index: lesson.order,
    });
  }

  // Make first lesson available if none are available/in_progress
  const allLessons = getLessons(lang);
  const hasActive = allLessons.some(l => l.status === "available" || l.status === "in_progress");

  if (!hasActive && allLessons.length > 0) {
    startLesson(allLessons[0].id);
  }

  return lessons.length;
}

export function getLessonData(id: string): LessonData | null {
  return lessonCache.get(id) || null;
}
