import { nodewhisper } from "nodejs-whisper";
import { execFile } from "child_process";
import { promisify } from "util";
import { unlink } from "fs/promises";

const exec = promisify(execFile);

async function oggToWav(input: string): Promise<string> {
  const output = input.replace(/\.ogg$/, ".wav");
  await exec("ffmpeg", ["-i", input, "-ar", "16000", "-ac", "1", "-f", "wav", "-y", output]);
  return output;
}

export async function transcribe(oggPath: string): Promise<string> {
  const wavPath = await oggToWav(oggPath);

  try {
    const result = await nodewhisper(wavPath, {
      modelName: process.env.WHISPER_MODEL || "base",
      autoDownloadModelName: process.env.WHISPER_MODEL || "base",
      whisperOptions: {
        outputInJson: true,
        language: "auto",
      },
    });

    return result.trim();
  } finally {
    await unlink(wavPath).catch(() => {});
  }
}
