import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly timeoutMs: number;
  /** Polled while the process runs; returning true ends it. */
  readonly shouldCancel?: () => boolean;
  /** Output kept per stream; anything past it is dropped and marked. */
  readonly maxOutputBytes?: number;
}

const DEFAULT_MAX_OUTPUT = 8 * 1024 * 1024;

/** Runs one program with its arguments, never through a shell. */
export function runProcess(command: string, args: readonly string[], options: ProcessOptions): Promise<ProcessResult> {
  const limit = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  return new Promise((resolve) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = collector(limit);
    const stderr = collector(limit);
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const stop = (): void => {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
      setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }, 2_000).unref();
    };
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs);
    const poll = options.shouldCancel === undefined ? undefined : setInterval(() => {
      if (options.shouldCancel?.() === true) { cancelled = true; stop(); }
    }, 500);

    const finish = (exitCode: number | null, error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (poll !== undefined) clearInterval(poll);
      resolve({
        exitCode,
        stdout: stdout.text(),
        stderr: error === undefined ? stderr.text() : `${stderr.text()}${error.message}`,
        timedOut,
        cancelled,
      });
    };

    child.stdout.on("data", (chunk: Buffer) => { stdout.add(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { stderr.add(chunk); });
    child.on("error", (error) => { finish(null, error); });
    child.on("close", (code) => { finish(code); });
    child.stdin.on("error", () => { /* the program may exit before reading its input */ });
    child.stdin.end(options.input ?? "");
  });
}

function collector(limit: number): { add(chunk: Buffer): void; text(): string } {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  return {
    add(chunk) {
      if (size >= limit) { truncated = true; return; }
      const room = limit - size;
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
      if (part.length < chunk.length) truncated = true;
      chunks.push(part);
      size += part.length;
    },
    text() {
      const text = Buffer.concat(chunks).toString("utf8");
      return truncated ? `${text}\n[output truncated by conclave-crew]` : text;
    },
  };
}
