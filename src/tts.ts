import { execFile } from "child_process";
import { promisify } from "util";
import { unlink } from "fs/promises";

const exec = promisify(execFile);

const KOKORO_LANGS: Record<string, { langCode: string; voice: string }> = {
  en:      { langCode: "a", voice: "af_heart" },
  "en-gb": { langCode: "b", voice: "bf_emma" },
  es:      { langCode: "e", voice: "ef_dora" },
  fr:      { langCode: "f", voice: "ff_siwis" },
  ja:      { langCode: "j", voice: "jf_alpha" },
  zh:      { langCode: "z", voice: "zf_xiaobei" },
  hi:      { langCode: "h", voice: "hf_alpha" },
  it:      { langCode: "i", voice: "if_sara" },
  pt:      { langCode: "p", voice: "pf_dora" },
};

async function toOgg(input: string, output: string): Promise<void> {
  await exec("ffmpeg", ["-i", input, "-c:a", "libopus", "-b:a", "48k", "-y", output]);
}

export async function synthesize(text: string, lang: string): Promise<string> {
  const id = Date.now();
  const outputOgg = `/tmp/tts_${id}.ogg`;

  if (KOKORO_LANGS[lang]) {
    const wavPath = `/tmp/tts_${id}.wav`;
    const { langCode, voice } = KOKORO_LANGS[lang];

    await exec("python3", [
      "python/tts_kokoro.py",
      "--text", text,
      "--lang", langCode,
      "--voice", voice,
      "--output", wavPath,
    ]);

    await toOgg(wavPath, outputOgg);
    await unlink(wavPath).catch(() => {});
  } else {
    const mp3Path = `/tmp/tts_${id}.mp3`;

    await exec("python3", [
      "python/tts_gtts.py",
      "--text", text,
      "--lang", lang,
      "--output", mp3Path,
    ]);

    await toOgg(mp3Path, outputOgg);
    await unlink(mp3Path).catch(() => {});
  }

  return outputOgg;
}
