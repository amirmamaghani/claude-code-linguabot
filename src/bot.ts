import "dotenv/config";
import { Bot, type Context, InputFile } from "grammy";
import { autoRetry } from "@grammyjs/auto-retry";
import { stream, type StreamFlavor } from "@grammyjs/stream";
import { askClaudeStream } from "./claude-bridge.js";
import { tutorPrompt, translatorPrompt, drillsPrompt, reviewPrompt, type LessonContext } from "./prompts.js";
import { transcribe } from "./stt.js";
import { synthesize } from "./tts.js";
import { unlink } from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

// DB & curriculum imports
import "./db/database.js"; // init DB on startup
import { addVocab, getDueVocab, getVocabStats, reviewVocab, getRecentVocab } from "./db/vocabulary.js";
import { getCurrentLesson, getLessons, getLesson, advancePhase, completeLesson, getLessonStats, startLesson } from "./db/lessons.js";
import { trackMessage, trackMode, trackVocabLearned, trackVocabReviewed, getStreak, getTodayStats, getWeekStats } from "./db/stats.js";
import { syncCurriculumToDb, getLessonData, type LessonData } from "./curriculum/loader.js";

type MyContext = StreamFlavor<Context>;

// ── Config ────────────────────────────────────────────────

const LANGUAGES: Record<string, { name: string; flag: string }> = {
  en: { name: "English", flag: "\u{1F1EC}\u{1F1E7}" },
  es: { name: "Spanish", flag: "\u{1F1EA}\u{1F1F8}" },
  fr: { name: "French", flag: "\u{1F1EB}\u{1F1F7}" },
  de: { name: "German", flag: "\u{1F1E9}\u{1F1EA}" },
  it: { name: "Italian", flag: "\u{1F1EE}\u{1F1F9}" },
  pt: { name: "Portuguese", flag: "\u{1F1E7}\u{1F1F7}" },
  ru: { name: "Russian", flag: "\u{1F1F7}\u{1F1FA}" },
  ja: { name: "Japanese", flag: "\u{1F1EF}\u{1F1F5}" },
  ko: { name: "Korean", flag: "\u{1F1F0}\u{1F1F7}" },
  zh: { name: "Chinese", flag: "\u{1F1E8}\u{1F1F3}" },
  ar: { name: "Arabic", flag: "\u{1F1F8}\u{1F1E6}" },
  hi: { name: "Hindi", flag: "\u{1F1EE}\u{1F1F3}" },
  tr: { name: "Turkish", flag: "\u{1F1F9}\u{1F1F7}" },
  nl: { name: "Dutch", flag: "\u{1F1F3}\u{1F1F1}" },
  pl: { name: "Polish", flag: "\u{1F1F5}\u{1F1F1}" },
  sv: { name: "Swedish", flag: "\u{1F1F8}\u{1F1EA}" },
  cs: { name: "Czech", flag: "\u{1F1E8}\u{1F1FF}" },
  uk: { name: "Ukrainian", flag: "\u{1F1FA}\u{1F1E6}" },
  ro: { name: "Romanian", flag: "\u{1F1F7}\u{1F1F4}" },
  hu: { name: "Hungarian", flag: "\u{1F1ED}\u{1F1FA}" },
  th: { name: "Thai", flag: "\u{1F1F9}\u{1F1ED}" },
  vi: { name: "Vietnamese", flag: "\u{1F1FB}\u{1F1F3}" },
  id: { name: "Indonesian", flag: "\u{1F1EE}\u{1F1E9}" },
  el: { name: "Greek", flag: "\u{1F1EC}\u{1F1F7}" },
};

// ── State ─────────────────────────────────────────────────

interface BotState {
  mode: "tutor" | "translator" | "drills";
  targetLang: string;
  nativeLang: string;
  level: "beginner" | "intermediate" | "advanced";
  voiceReplies: boolean;
  drillCategory: string;
  claudeSessionId: string | undefined;
  busy: boolean;
  activeLessonId: string | undefined;
}

const state: BotState = {
  mode: "tutor",
  targetLang: process.env.TARGET_LANG || "es",
  nativeLang: process.env.NATIVE_LANG || "en",
  level: "beginner",
  voiceReplies: true,
  drillCategory: "general",
  claudeSessionId: undefined,
  busy: false,
  activeLessonId: undefined,
};

// ── Init curriculum ───────────────────────────────────────

const lessonCount = syncCurriculumToDb(state.targetLang);
console.log(`Loaded ${lessonCount} lessons for ${state.targetLang}`);

// Set active lesson if available
const currentLesson = getCurrentLesson(state.targetLang);
if (currentLesson) {
  state.activeLessonId = currentLesson.id;
  console.log(`Active lesson: ${currentLesson.title}`);
}

// ── Text processing ───────────────────────────────────────

function cleanForTTS(text: string): string {
  return text
    .replace(/[*_`#~\[\]]/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/[\u{1F300}-\u{1FAD6}]/gu, "")
    .replace(/\|/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Prompt builder ────────────────────────────────────────

function buildLessonContext(): LessonContext | undefined {
  if (!state.activeLessonId) return undefined;

  const lessonRow = getLesson(state.activeLessonId);
  if (!lessonRow) return undefined;

  const lessonData = getLessonData(state.activeLessonId);
  if (!lessonData) return undefined;

  const dueVocab = getDueVocab(state.targetLang, 5);

  return {
    lesson: lessonData,
    phase: lessonRow.current_phase,
    dueVocab,
  };
}

function currentPrompt(): string {
  const t = LANGUAGES[state.targetLang]?.name || state.targetLang;
  const n = LANGUAGES[state.nativeLang]?.name || state.nativeLang;
  const lessonCtx = buildLessonContext();

  switch (state.mode) {
    case "tutor":
      return tutorPrompt(t, n, state.level, lessonCtx);
    case "translator":
      return translatorPrompt(t, n);
    case "drills":
      return drillsPrompt(t, n, state.level, state.drillCategory, lessonCtx);
  }
}

// ── Parse vocab from Claude response ──────────────────────

function parseVocabScores(text: string): Array<{ word: string; score: number }> {
  const regex = /\[VOCAB_SCORE:(.+?):(\d)\]/g;
  const results: Array<{ word: string; score: number }> = [];
  let match;
  while ((match = regex.exec(text)) !== null) {
    results.push({ word: match[1], score: parseInt(match[2]) });
  }
  return results;
}

// ── Streaming handler ─────────────────────────────────────

async function handleStreamingMessage(ctx: MyContext, userText: string): Promise<void> {
  // Track stats
  trackMessage();
  trackMode(state.mode);

  const { chunks, result } = askClaudeStream(userText, currentPrompt(), state.claudeSessionId);

  // Stream display text to Telegram, stop before |||SPEAK|||
  let fullText = "";
  let hitSeparator = false;

  async function* displayChunks(): AsyncGenerator<string> {
    for await (const chunk of chunks) {
      fullText += chunk;

      if (fullText.includes("|||SPEAK|||")) {
        const sepIndex = fullText.indexOf("|||SPEAK|||");
        const alreadyYielded = fullText.length - chunk.length;
        if (sepIndex > alreadyYielded) {
          yield fullText.slice(alreadyYielded, sepIndex);
        }
        hitSeparator = true;
        continue;
      }

      if (!hitSeparator) {
        yield chunk;
      }
    }
  }

  const messages = await ctx.replyWithStream(displayChunks());

  // Edit final message with Markdown formatting
  for (const msg of messages) {
    if (msg.text) {
      await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, msg.text, {
        parse_mode: "Markdown",
      }).catch(() => {});
    }
  }

  // Wait for Claude to finish and get session ID
  const claudeResult = await result;
  state.claudeSessionId = claudeResult.sessionId;

  // Parse vocab scores from review sessions
  const vocabScores = parseVocabScores(fullText);
  if (vocabScores.length > 0) {
    const recentVocab = getRecentVocab(state.targetLang, 100);
    for (const { word, score } of vocabScores) {
      const entry = recentVocab.find(v => v.word === word);
      if (entry) {
        reviewVocab(entry.id, score);
      }
    }
    trackVocabReviewed(vocabScores.length);
  }

  // Extract speakable text and send voice
  if (state.voiceReplies && fullText.includes("|||SPEAK|||")) {
    const speakPart = fullText.split("|||SPEAK|||")[1] || "";
    const speakText = cleanForTTS(speakPart);
    if (speakText) {
      const audioPath = await synthesize(speakText, state.targetLang);
      await ctx.replyWithVoice(new InputFile(audioPath));
      await unlink(audioPath).catch(() => {});
    }
  }
}

// ── Helpers ───────────────────────────────────────────────

async function downloadFile(bot: Bot<MyContext>, fileId: string, dest: string): Promise<void> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
  const ws = createWriteStream(dest);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, ws);
}

function progressBar(current: number, total: number, width = 10): string {
  if (total === 0) return "\u2591".repeat(width);
  const filled = Math.round((current / total) * width);
  return "\u2593".repeat(filled) + "\u2591".repeat(width - filled);
}

// ── Bot setup ─────────────────────────────────────────────

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const OWNER_ID = Number(process.env.TELEGRAM_USER_ID);

if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}
if (!OWNER_ID) {
  console.error("TELEGRAM_USER_ID is required");
  process.exit(1);
}

const bot = new Bot<MyContext>(TOKEN);

// Plugins
bot.api.config.use(autoRetry());
bot.use(stream());

// Auth guard
bot.use(async (ctx, next) => {
  if (ctx.from?.id !== OWNER_ID) return;
  await next();
});

// ── Voice handler ─────────────────────────────────────────

bot.on("message:voice", async (ctx) => {
  if (state.busy) return ctx.reply("Still thinking about your last message...");
  state.busy = true;

  try {
    const oggPath = `/tmp/voice_${Date.now()}.ogg`;
    await downloadFile(bot, ctx.message.voice.file_id, oggPath);

    await ctx.replyWithChatAction("typing");
    const text = await transcribe(oggPath);
    await unlink(oggPath).catch(() => {});

    if (!text) return ctx.reply("Couldn't understand that. Try again or type your message.");

    await handleStreamingMessage(ctx, text);
  } catch (err) {
    console.error("Voice handler error:", err);
    await ctx.reply("Something went wrong. Try again.");
  } finally {
    state.busy = false;
  }
});

// ── Text handler ──────────────────────────────────────────

bot.on("message:text", async (ctx) => {
  if (ctx.message.text.startsWith("/")) return;
  if (state.busy) return ctx.reply("Still thinking...");
  state.busy = true;

  try {
    await handleStreamingMessage(ctx, ctx.message.text);
  } catch (err) {
    console.error("Text handler error:", err);
    await ctx.reply("Something went wrong. Try again.");
  } finally {
    state.busy = false;
  }
});

// ── Original Commands ────────────────────────────────────

bot.command("start", (ctx) => {
  const t = LANGUAGES[state.targetLang];
  const n = LANGUAGES[state.nativeLang];
  const streak = getStreak();
  const vocabStats = getVocabStats(state.targetLang);
  const lessonStats = getLessonStats(state.targetLang);
  const lesson = state.activeLessonId ? getLesson(state.activeLessonId) : null;

  return ctx.reply(
    `LinguaBot\n\n` +
    `Learning: ${t?.flag || ""} ${t?.name || state.targetLang}\n` +
    `Native: ${n?.flag || ""} ${n?.name || state.nativeLang}\n` +
    `Level: ${state.level}\n` +
    `Mode: ${state.mode}\n\n` +
    `Streak: ${streak} ${streak > 0 ? "day" + (streak > 1 ? "s" : "") : "days"}\n` +
    `Vocabulary: ${vocabStats.total} words (${vocabStats.mastered} mastered, ${vocabStats.due} due)\n` +
    `Lessons: ${lessonStats.completed || 0} completed / ${(lessonStats.completed || 0) + (lessonStats.available || 0) + (lessonStats.in_progress || 0) + (lessonStats.locked || 0)} total\n` +
    (lesson ? `Current lesson: ${lesson.title}\n` : "") +
    `\nSend me a voice memo or text to start learning!\n` +
    `Use /help to see all commands.`
  );
});

bot.command("mode", (ctx) =>
  ctx.reply("Choose a mode:", {
    reply_markup: {
      inline_keyboard: [[
        { text: "Tutor", callback_data: "mode:tutor" },
        { text: "Translator", callback_data: "mode:translator" },
        { text: "Drills", callback_data: "mode:drills" },
      ]],
    },
  })
);

bot.callbackQuery(/^mode:(.+)$/, async (ctx) => {
  const mode = ctx.match![1] as BotState["mode"];
  state.mode = mode;
  state.claudeSessionId = undefined;
  await ctx.answerCallbackQuery(`Switched to ${mode}`);
  await ctx.editMessageText(`Mode: ${mode}`);
});

bot.command("lang", (ctx) => {
  const buttons = Object.entries(LANGUAGES).map(([code, { flag, name }]) => ({
    text: `${flag} ${name}`,
    callback_data: `lang:${code}`,
  }));
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 3) {
    keyboard.push(buttons.slice(i, i + 3));
  }
  return ctx.reply("Learn which language?", {
    reply_markup: { inline_keyboard: keyboard },
  });
});

bot.callbackQuery(/^lang:(.+)$/, async (ctx) => {
  state.targetLang = ctx.match![1];
  state.claudeSessionId = undefined;
  // Reload curriculum for new language
  const count = syncCurriculumToDb(state.targetLang);
  const lesson = getCurrentLesson(state.targetLang);
  state.activeLessonId = lesson?.id;
  const l = LANGUAGES[state.targetLang];
  await ctx.answerCallbackQuery(`Now learning ${l?.name || state.targetLang} (${count} lessons)`);
  await ctx.editMessageText(`Target: ${l?.flag || ""} ${l?.name || state.targetLang}`);
});

bot.command("native", (ctx) => {
  const buttons = Object.entries(LANGUAGES).map(([code, { flag, name }]) => ({
    text: `${flag} ${name}`,
    callback_data: `native:${code}`,
  }));
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 3) {
    keyboard.push(buttons.slice(i, i + 3));
  }
  return ctx.reply("Your native language?", {
    reply_markup: { inline_keyboard: keyboard },
  });
});

bot.callbackQuery(/^native:(.+)$/, async (ctx) => {
  state.nativeLang = ctx.match![1];
  state.claudeSessionId = undefined;
  const l = LANGUAGES[state.nativeLang];
  await ctx.answerCallbackQuery(`Native: ${l?.name || state.nativeLang}`);
  await ctx.editMessageText(`Native: ${l?.flag || ""} ${l?.name || state.nativeLang}`);
});

bot.command("level", (ctx) =>
  ctx.reply("Your level:", {
    reply_markup: {
      inline_keyboard: [[
        { text: "Beginner", callback_data: "level:beginner" },
        { text: "Intermediate", callback_data: "level:intermediate" },
        { text: "Advanced", callback_data: "level:advanced" },
      ]],
    },
  })
);

bot.callbackQuery(/^level:(.+)$/, async (ctx) => {
  state.level = ctx.match![1] as BotState["level"];
  await ctx.answerCallbackQuery(`Level: ${state.level}`);
  await ctx.editMessageText(`Level: ${state.level}`);
});

bot.command("voice", (ctx) => {
  state.voiceReplies = !state.voiceReplies;
  return ctx.reply(`Voice replies: ${state.voiceReplies ? "ON" : "OFF"}`);
});

bot.command("drills", (ctx) => {
  const categories = [
    "greetings", "restaurant", "travel", "shopping",
    "emergency", "small talk", "business", "numbers",
    "directions", "weather", "family", "food",
  ];
  const buttons = categories.map((c) => ({
    text: c.charAt(0).toUpperCase() + c.slice(1),
    callback_data: `drill:${c}`,
  }));
  const keyboard = [];
  for (let i = 0; i < buttons.length; i += 3) {
    keyboard.push(buttons.slice(i, i + 3));
  }
  return ctx.reply("Pick a drill category:", {
    reply_markup: { inline_keyboard: keyboard },
  });
});

bot.callbackQuery(/^drill:(.+)$/, async (ctx) => {
  state.drillCategory = ctx.match![1];
  state.mode = "drills";
  state.claudeSessionId = undefined;
  await ctx.answerCallbackQuery(`Drills: ${state.drillCategory}`);
  await ctx.editMessageText(`Drilling: ${state.drillCategory}`);
});

bot.command("reset", (ctx) => {
  state.claudeSessionId = undefined;
  return ctx.reply("Conversation cleared. Fresh start!");
});

// ── New Progress & Lesson Commands ────────────────────────

bot.command("progress", (ctx) => {
  const streak = getStreak();
  const vocabStats = getVocabStats(state.targetLang);
  const lessonStats = getLessonStats(state.targetLang);
  const todayStats = getTodayStats();
  const t = LANGUAGES[state.targetLang];
  const lesson = state.activeLessonId ? getLesson(state.activeLessonId) : null;

  const totalLessons = (lessonStats.completed || 0) + (lessonStats.available || 0) + (lessonStats.in_progress || 0) + (lessonStats.locked || 0);

  let text = `Progress: ${t?.flag || ""} ${t?.name || state.targetLang}\n\n`;
  text += `Streak: ${streak} day${streak !== 1 ? "s" : ""}\n`;
  text += `Lessons: ${progressBar(lessonStats.completed || 0, totalLessons)} ${lessonStats.completed || 0}/${totalLessons}\n`;
  text += `Vocabulary: ${vocabStats.total} words\n`;
  text += `  Mastered: ${vocabStats.mastered}\n`;
  text += `  Due for review: ${vocabStats.due}\n`;

  if (lesson) {
    const lessonData = getLessonData(lesson.id);
    const totalPhases = lessonData?.phases.length || 1;
    text += `\nCurrent lesson: ${lesson.title}`;
    if (lesson.title_native) text += ` (${lesson.title_native})`;
    text += `\nPhase: ${lesson.current_phase + 1}/${totalPhases}\n`;
  }

  if (todayStats) {
    text += `\nToday:\n`;
    text += `  Messages: ${todayStats.messages_sent}\n`;
    text += `  Vocab reviewed: ${todayStats.vocab_reviewed}\n`;
    text += `  Vocab learned: ${todayStats.vocab_learned}\n`;
  }

  return ctx.reply(text);
});

bot.command("lesson", async (ctx) => {
  if (!state.activeLessonId) {
    const lesson = getCurrentLesson(state.targetLang);
    if (!lesson) {
      return ctx.reply("No lessons available. Check /lessons for curriculum status.");
    }
    state.activeLessonId = lesson.id;
  }

  const lesson = getLesson(state.activeLessonId!);
  if (!lesson) return ctx.reply("Lesson not found.");

  const lessonData = getLessonData(lesson.id);
  if (!lessonData) return ctx.reply("Lesson data not found. Check curriculum files.");

  const totalPhases = lessonData.phases.length;
  const currentPhase = lessonData.phases[lesson.current_phase];

  if (!currentPhase) {
    // All phases done — complete the lesson
    return ctx.reply(
      `Lesson "${lesson.title}" — all phases completed!\n\n` +
      `Use /complete to finish and score this lesson.`,
      {
        reply_markup: {
          inline_keyboard: [[
            { text: "Complete lesson (score: 80)", callback_data: "complete:80" },
            { text: "Complete lesson (score: 90)", callback_data: "complete:90" },
            { text: "Redo lesson", callback_data: "redo_lesson" },
          ]],
        },
      }
    );
  }

  // Set the mode from the current phase
  state.mode = currentPhase.mode;
  if (currentPhase.category) state.drillCategory = currentPhase.category;
  state.claudeSessionId = undefined; // fresh context for phase

  // Start the lesson if it's locked/available
  if (lesson.status === "available" || lesson.status === "locked") {
    startLesson(lesson.id);
  }

  let text = `Lesson: ${lesson.title}`;
  if (lesson.title_native) text += ` (${lesson.title_native})`;
  text += `\nPhase ${lesson.current_phase + 1}/${totalPhases}: ${currentPhase.mode.toUpperCase()}`;
  text += `\n\n${currentPhase.instruction}`;
  text += `\n\nMode set to ${currentPhase.mode}. Send a message to begin!`;

  // Add vocab from the lesson to DB
  for (const v of lessonData.vocabulary) {
    addVocab(v.word, state.targetLang, v.translation, v.usage, "lesson", lesson.id);
  }
  trackVocabLearned(lessonData.vocabulary.length);

  return ctx.reply(text);
});

bot.command("next_phase", async (ctx) => {
  if (!state.activeLessonId) return ctx.reply("No active lesson. Use /lesson to start one.");

  const lesson = getLesson(state.activeLessonId);
  if (!lesson) return ctx.reply("Lesson not found.");

  const lessonData = getLessonData(lesson.id);
  if (!lessonData) return ctx.reply("Lesson data not found.");

  const nextPhase = lesson.current_phase + 1;
  if (nextPhase >= lessonData.phases.length) {
    return ctx.reply(
      `All phases of "${lesson.title}" are done!\n\nChoose a score:`,
      {
        reply_markup: {
          inline_keyboard: [
            [
              { text: "70%", callback_data: "complete:70" },
              { text: "80%", callback_data: "complete:80" },
              { text: "90%", callback_data: "complete:90" },
              { text: "100%", callback_data: "complete:100" },
            ],
            [{ text: "Redo lesson", callback_data: "redo_lesson" }],
          ],
        },
      }
    );
  }

  advancePhase(state.activeLessonId, nextPhase);
  state.claudeSessionId = undefined;

  const phase = lessonData.phases[nextPhase];
  state.mode = phase.mode;
  if (phase.category) state.drillCategory = phase.category;

  return ctx.reply(
    `Phase ${nextPhase + 1}/${lessonData.phases.length}: ${phase.mode.toUpperCase()}\n\n${phase.instruction}\n\nMode set to ${phase.mode}. Send a message to continue!`
  );
});

bot.callbackQuery(/^complete:(\d+)$/, async (ctx) => {
  if (!state.activeLessonId) return ctx.answerCallbackQuery("No active lesson");

  const score = parseInt(ctx.match![1]);
  completeLesson(state.activeLessonId, score);

  const lesson = getLesson(state.activeLessonId);
  await ctx.answerCallbackQuery(`Lesson completed: ${score}%`);

  // Find next lesson
  const next = getCurrentLesson(state.targetLang);
  state.activeLessonId = next?.id;
  state.claudeSessionId = undefined;

  let text = `Lesson completed with score: ${score}%`;
  if (score >= 70 && next) {
    text += `\n\nNext lesson unlocked: ${next.title}`;
    if (next.title_native) text += ` (${next.title_native})`;
    text += `\nUse /lesson to start it!`;
  } else if (score < 70) {
    text += `\n\nScore below 70% — lesson not passed. Try again with /lesson.`;
  } else {
    text += `\n\nAll available lessons completed!`;
  }

  await ctx.editMessageText(text);
});

bot.callbackQuery("redo_lesson", async (ctx) => {
  if (!state.activeLessonId) return ctx.answerCallbackQuery("No active lesson");

  advancePhase(state.activeLessonId, 0);
  state.claudeSessionId = undefined;

  await ctx.answerCallbackQuery("Lesson reset");
  await ctx.editMessageText("Lesson reset to phase 1. Use /lesson to start again.");
});

bot.command("lessons", (ctx) => {
  const allLessons = getLessons(state.targetLang);
  const t = LANGUAGES[state.targetLang];

  if (allLessons.length === 0) {
    return ctx.reply(`No curriculum found for ${t?.name || state.targetLang}. Add YAML files to data/curriculum/${state.targetLang}/`);
  }

  let text = `Lessons: ${t?.flag || ""} ${t?.name || state.targetLang}\n\n`;
  let currentLevel = "";

  for (const lesson of allLessons) {
    if (lesson.level !== currentLevel) {
      currentLevel = lesson.level;
      text += `\n${currentLevel}:\n`;
    }

    const icon = lesson.status === "completed" ? "\u2705" :
                 lesson.status === "in_progress" ? "\u{1F4D6}" :
                 lesson.status === "available" ? "\u{1F513}" : "\u{1F512}";
    const scoreStr = lesson.score !== null ? ` (${lesson.score}%)` : "";
    text += `${icon} ${lesson.title}${scoreStr}\n`;
  }

  text += `\n\u2705 = done  \u{1F4D6} = in progress  \u{1F513} = available  \u{1F512} = locked`;

  return ctx.reply(text);
});

bot.command("vocab", (ctx) => {
  const due = getDueVocab(state.targetLang, 20);
  const stats = getVocabStats(state.targetLang);

  if (due.length === 0) {
    return ctx.reply(`No vocabulary due for review! (${stats.total} total words, ${stats.mastered} mastered)\n\nUse /review to start a review session when words are due.`);
  }

  let text = `Vocabulary due for review: ${due.length} words\n\n`;
  for (const v of due) {
    const stars = "\u2B50".repeat(Math.min(v.repetitions, 5));
    text += `${v.word} — ${v.translation || "?"} ${stars}\n`;
  }
  text += `\nUse /review to start a spaced repetition session.`;

  return ctx.reply(text);
});

bot.command("review", async (ctx) => {
  if (state.busy) return ctx.reply("Still thinking...");

  const due = getDueVocab(state.targetLang, 10);
  if (due.length === 0) {
    return ctx.reply("No words due for review right now! Come back later.");
  }

  state.busy = true;
  try {
    const t = LANGUAGES[state.targetLang]?.name || state.targetLang;
    const n = LANGUAGES[state.nativeLang]?.name || state.nativeLang;
    const prompt = reviewPrompt(t, n, due);

    state.claudeSessionId = undefined; // fresh session for review
    const { chunks, result } = askClaudeStream("Start the review session.", prompt, undefined);

    let fullText = "";
    let hitSeparator = false;

    async function* displayChunks(): AsyncGenerator<string> {
      for await (const chunk of chunks) {
        fullText += chunk;
        if (fullText.includes("|||SPEAK|||")) {
          const sepIndex = fullText.indexOf("|||SPEAK|||");
          const alreadyYielded = fullText.length - chunk.length;
          if (sepIndex > alreadyYielded) {
            yield fullText.slice(alreadyYielded, sepIndex);
          }
          hitSeparator = true;
          continue;
        }
        if (!hitSeparator) yield chunk;
      }
    }

    const messages = await ctx.replyWithStream(displayChunks());
    for (const msg of messages) {
      if (msg.text) {
        await ctx.api.editMessageText(ctx.chat!.id, msg.message_id, msg.text, {
          parse_mode: "Markdown",
        }).catch(() => {});
      }
    }

    const claudeResult = await result;
    state.claudeSessionId = claudeResult.sessionId;

    // Parse and apply vocab scores
    const scores = parseVocabScores(fullText);
    for (const { word, score } of scores) {
      const entry = due.find(v => v.word === word);
      if (entry) reviewVocab(entry.id, score);
    }
    if (scores.length > 0) trackVocabReviewed(scores.length);

    if (state.voiceReplies && fullText.includes("|||SPEAK|||")) {
      const speakPart = fullText.split("|||SPEAK|||")[1] || "";
      const speakText = cleanForTTS(speakPart);
      if (speakText) {
        const audioPath = await synthesize(speakText, state.targetLang);
        await ctx.replyWithVoice(new InputFile(audioPath));
        await unlink(audioPath).catch(() => {});
      }
    }
  } catch (err) {
    console.error("Review error:", err);
    await ctx.reply("Something went wrong with the review. Try again.");
  } finally {
    state.busy = false;
  }
});

bot.command("stats", (ctx) => {
  const week = getWeekStats();
  const streak = getStreak();
  const vocabStats = getVocabStats(state.targetLang);
  const t = LANGUAGES[state.targetLang];

  let text = `Stats: ${t?.flag || ""} ${t?.name || state.targetLang}\n\n`;
  text += `Streak: ${streak} day${streak !== 1 ? "s" : ""}\n`;
  text += `Vocabulary: ${vocabStats.total} total, ${vocabStats.mastered} mastered\n\n`;
  text += `This week:\n`;

  if (week.length === 0) {
    text += "No activity yet.\n";
  } else {
    for (const day of week) {
      const dayName = new Date(day.date + "T12:00:00").toLocaleDateString("en", { weekday: "short" });
      text += `${dayName}: ${day.messages_sent} msgs, ${day.vocab_reviewed} reviewed, ${day.vocab_learned} learned\n`;
    }
  }

  return ctx.reply(text);
});

bot.command("help", (ctx) =>
  ctx.reply(
    `Commands:\n\n` +
    `Learning:\n` +
    `/mode — Switch: Tutor, Translator, Drills\n` +
    `/lang — Change target language\n` +
    `/native — Change native language\n` +
    `/level — Beginner / Intermediate / Advanced\n` +
    `/voice — Toggle voice replies\n` +
    `/drills — Pick drill category\n` +
    `/reset — Clear conversation\n\n` +
    `Lessons:\n` +
    `/lesson — Start / continue current lesson\n` +
    `/next_phase — Advance to next lesson phase\n` +
    `/lessons — View all lessons and progress\n\n` +
    `Progress:\n` +
    `/progress — Dashboard with stats\n` +
    `/vocab — View vocabulary due for review\n` +
    `/review — Start spaced repetition session\n` +
    `/stats — Weekly statistics\n\n` +
    `/help — This message`
  )
);

// ── Error handling ────────────────────────────────────────

bot.catch((err) => {
  console.error("Bot error:", err);
});

// ── Start ─────────────────────────────────────────────────

bot.start({
  drop_pending_updates: true,
  onStart: () => console.log("LinguaBot running"),
});
