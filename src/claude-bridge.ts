import { spawn } from "child_process";

export interface ClaudeResult {
  text: string;
  sessionId: string;
}

export async function askClaude(
  message: string,
  systemPrompt: string,
  sessionId?: string
): Promise<ClaudeResult> {
  const args = [
    "-p",
    "--output-format", "json",
    "--model", "sonnet",
    "--bare",
    "--system-prompt", systemPrompt,
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  return new Promise((resolve, reject) => {
    const proc = spawn("claude", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.stdin.write(message);
    proc.stdin.end();

    const timeout = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Claude timed out (60s)"));
    }, 60_000);

    proc.on("close", (code) => {
      clearTimeout(timeout);

      if (code !== 0) {
        reject(new Error(`claude exit ${code}: ${stderr}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout);
        resolve({
          text: parsed.result || "",
          sessionId: parsed.session_id || sessionId || "",
        });
      } catch {
        resolve({ text: stdout.trim(), sessionId: "" });
      }
    });
  });
}
