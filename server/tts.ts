// local patch: read-aloud text to speech. One persistent Kokoro worker
// (~/.claude/tools/kokoro/tts_worker.py) is spawned on first use, because loading the model takes
// seconds; requests go through it one at a time and each answer is a WAV file the server reads
// and deletes. A worker that dies is spawned again by the next request.
import { readFile, unlink } from "node:fs/promises";

const KOKORO = "C:/Users/mehdiali/.claude/tools/kokoro";
export const TTS_MAX_CHARS = 2000;
const TTS_VOICE = "bm_fable";
const TTS_SPEED = 1.1;
// a cold model load plus one sentence; a sentence on a warm worker takes about a second
const TTS_TIMEOUT_MS = 90_000;

type Reply = { id?: number; path?: string; error?: string; ready?: boolean };
type Worker = { proc: Bun.Subprocess<"pipe", "pipe", "ignore">; waiting: Map<number, (reply: Reply) => void>; dead: boolean };

let worker: Worker | null = null;
let nextId = 0;
let queue: Promise<unknown> = Promise.resolve();

function spawnWorker(): Worker {
  const python = process.env.OVIS_TTS_PYTHON ?? `${KOKORO}/.venv/Scripts/python.exe`;
  const script = process.env.OVIS_TTS_WORKER ?? `${KOKORO}/tts_worker.py`;
  const proc = Bun.spawn([python, script], { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true });
  const made: Worker = { proc, waiting: new Map(), dead: false };
  const die = () => {
    made.dead = true;
    if (worker === made) worker = null;
    for (const [id, resolve] of made.waiting) resolve({ id, error: "tts worker exited" });
    made.waiting.clear();
  };
  void (async () => {
    const decoder = new TextDecoder();
    let pending = "";
    try {
      for await (const chunk of proc.stdout) {
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        for (const line of lines) {
          let reply: Reply;
          try { reply = JSON.parse(line) as Reply; } catch { continue; }
          if (typeof reply.id === "number") {
            made.waiting.get(reply.id)?.(reply);
            made.waiting.delete(reply.id);
          }
        }
      }
    } catch { /* the worker closed its output */ }
    die();
  })();
  void proc.exited.then(die);
  return made;
}

async function synthesize(text: string): Promise<ArrayBuffer> {
  const live = worker !== null && !worker.dead ? worker : (worker = spawnWorker());
  const id = ++nextId;
  const reply = await new Promise<Reply>((resolve) => {
    const timer = setTimeout(() => {
      live.waiting.delete(id);
      // a worker that does not answer is stuck: drop it, the next request starts a new one
      live.proc.kill();
      resolve({ id, error: "tts timed out" });
    }, TTS_TIMEOUT_MS);
    live.waiting.set(id, (r) => { clearTimeout(timer); resolve(r); });
    try {
      live.proc.stdin.write(`${JSON.stringify({ id, text, voice: TTS_VOICE, speed: TTS_SPEED })}\n`);
      void live.proc.stdin.flush();
    } catch {
      clearTimeout(timer);
      live.waiting.delete(id);
      resolve({ id, error: "tts worker is not accepting input" });
    }
  });
  if (reply.error !== undefined || typeof reply.path !== "string") throw new Error(reply.error ?? "tts gave no audio");
  try {
    const bytes = await readFile(reply.path);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  } finally {
    void unlink(reply.path).catch(() => undefined);
  }
}

/** The WAV (24 kHz mono 16-bit) for one sentence. Calls are served one at a time. */
export function speak(text: string): Promise<ArrayBuffer> {
  const run = queue.then(() => synthesize(text));
  queue = run.catch(() => undefined);
  return run;
}
