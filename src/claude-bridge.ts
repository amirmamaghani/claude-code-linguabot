import { spawn } from "child_process";
import { createInterface } from "readline";

export interface ClaudeResult {
  text: string;
  sessionId: string;
}

export interface ClaudeStream {
  chunks: AsyncIterable<string>;
  result: Promise<ClaudeResult>;
}

export function askClaudeStream(
  message: string,
  systemPrompt: string,
  sessionId?: string
): ClaudeStream {
  const args = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--model", "sonnet",
    "--system-prompt", systemPrompt,
  ];

  if (sessionId) {
    args.push("--resume", sessionId);
  }

  const proc = spawn("claude", args, {
    stdio: ["pipe", "pipe", "pipe"],
  });

  proc.stdin.write(message);
  proc.stdin.end();

  const timeout = setTimeout(() => {
    proc.kill("SIGTERM");
  }, 120_000);

  let resolveResult: (r: ClaudeResult) => void;
  let rejectResult: (e: Error) => void;
  const result = new Promise<ClaudeResult>((res, rej) => {
    resolveResult = res;
    rejectResult = rej;
  });

  let fullText = "";
  let finalSessionId = sessionId || "";

  const rl = createInterface({ input: proc.stdout });
  const lineQueue: string[] = [];
  let lineDone = false;
  let lineWaiter: (() => void) | null = null;

  rl.on("line", (line) => {
    try {
      const event = JSON.parse(line);

      if (event.type === "assistant" && event.message?.content) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            lineQueue.push(block.text);
            lineWaiter?.();
            lineWaiter = null;
          }
        }
      }

      if (event.type === "result") {
        fullText = event.result || fullText;
        finalSessionId = event.session_id || finalSessionId;
      }
    } catch {
      // skip non-JSON lines
    }
  });

  rl.on("close", () => {
    lineDone = true;
    lineWaiter?.();
    lineWaiter = null;
  });

  let stderr = "";
  proc.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  proc.on("close", (code) => {
    clearTimeout(timeout);
    if (code !== 0) {
      rejectResult!(new Error(`claude exit ${code}: ${stderr}`));
    } else {
      resolveResult!({ text: fullText, sessionId: finalSessionId });
    }
  });

  async function* streamChunks(): AsyncGenerator<string> {
    while (true) {
      while (lineQueue.length > 0) {
        yield lineQueue.shift()!;
      }
      if (lineDone) break;
      await new Promise<void>((r) => { lineWaiter = r; });
    }
  }

  return { chunks: streamChunks(), result };
}
