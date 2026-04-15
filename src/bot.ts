import "dotenv/config";
import { Bot, InputFile } from "grammy";
import { askClaude } from "./claude-bridge.js";
import { tutorPrompt, translatorPrompt, drillsPrompt } from "./prompts.js";
import { transcribe } from "./stt.js";
import { synthesize } from "./tts.js";
import { unlink } from "fs/promises";
import { createWriteStream } from "fs";
import { pipeline } from "stream/promises";

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
};

// ── Text processing ───────────────────────────────────────

function extractSpeakable(response: string): { displayText: string; speakText: string } {
  if (response.includes("|||SPEAK|||")) {
    const [display, speak] = response.split("|||SPEAK|||", 2);
    const cleaned = speak
      .replace(/[*_`#~\[\]]/g, "")
      .replace(/\(.*?\)/g, "")
      .replace(/[\u{1F300}-\u{1FAD6}]/gu, "")
      .replace(/\|/g, "")
      .replace(/\s+/g, " ")
      .trim();
    return { displayText: display.trim(), speakText: cleaned };
  }
  return { displayText: response.trim(), speakText: "" };
}

// ── Prompt builder ────────────────────────────────────────

function currentPrompt(): string {
  const t = LANGUAGES[state.targetLang]?.name || state.targetLang;
  const n = LANGUAGES[state.nativeLang]?.name || state.nativeLang;

  switch (state.mode) {
    case "tutor":
      return tutorPrompt(t, n, state.level);
    case "translator":
      return translatorPrompt(t, n);
    case "drills":
      return drillsPrompt(t, n, state.level, state.drillCategory);
  }
}

// ── Helpers ───────────────────────────────────────────────

async function handleMessage(text: string): Promise<{ displayText: string; speakText: string }> {
  const response = await askClaude(text, currentPrompt(), state.claudeSessionId);
  state.claudeSessionId = response.sessionId;
  return extractSpeakable(response.text);
}

async function sendReply(
  ctx: { reply: (t: string, o?: object) => Promise<unknown>; replyWithVoice: (f: InputFile) => Promise<unknown> },
  displayText: string,
  speakText: string
): Promise<void> {
  await ctx.reply(displayText, { parse_mode: "Markdown" }).catch(() =>
    ctx.reply(displayText)
  );

  if (state.voiceReplies && speakText) {
    const audioPath = await synthesize(speakText, state.targetLang);
    await ctx.replyWithVoice(new InputFile(audioPath));
    await unlink(audioPath).catch(() => {});
  }
}

async function downloadFile(bot: Bot, fileId: string, dest: string): Promise<void> {
  const file = await bot.api.getFile(fileId);
  const url = `https://api.telegram.org/file/bot${bot.token}/${file.file_path}`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
  const ws = createWriteStream(dest);
  await pipeline(res.body as unknown as NodeJS.ReadableStream, ws);
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

const bot = new Bot(TOKEN);

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

    const { displayText, speakText } = await handleMessage(text);
    await sendReply(ctx, displayText, speakText);
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
    await ctx.replyWithChatAction("typing");
    const { displayText, speakText } = await handleMessage(ctx.message.text);
    await sendReply(ctx, displayText, speakText);
  } catch (err) {
    console.error("Text handler error:", err);
    await ctx.reply("Something went wrong. Try again.");
  } finally {
    state.busy = false;
  }
});

// ── Commands ──────────────────────────────────────────────

bot.command("start", (ctx) => {
  const t = LANGUAGES[state.targetLang];
  const n = LANGUAGES[state.nativeLang];
  return ctx.reply(
    `LinguaBot\n\n` +
    `Learning: ${t?.flag || ""} ${t?.name || state.targetLang}\n` +
    `Native: ${n?.flag || ""} ${n?.name || state.nativeLang}\n` +
    `Level: ${state.level}\n` +
    `Mode: ${state.mode}\n\n` +
    `Send me a voice memo or text to start learning!\n` +
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
  const l = LANGUAGES[state.targetLang];
  await ctx.answerCallbackQuery(`Now learning ${l?.name || state.targetLang}`);
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

bot.command("help", (ctx) =>
  ctx.reply(
    `/mode — Switch: Tutor, Translator, Drills\n` +
    `/lang — Change target language\n` +
    `/native — Change native language\n` +
    `/level — Beginner / Intermediate / Advanced\n` +
    `/voice — Toggle voice replies\n` +
    `/drills — Pick drill category\n` +
    `/reset — Clear conversation\n` +
    `/help — This message`
  )
);

// ── Start ─────────────────────────────────────────────────

bot.start({
  onStart: () => console.log("LinguaBot running"),
});
