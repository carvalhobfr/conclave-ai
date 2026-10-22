import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import type { ProviderId } from "../domain/provider.js";
import { ProviderError } from "../domain/provider.js";

export interface CliRun {
  readonly provider: ProviderId;
  /** Human name used in error messages, e.g. "Claude CLI". */
  readonly label: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
  /** Variables removed from the child environment, e.g. API keys that would bill the API instead of a subscription. */
  readonly withoutEnvironment: readonly string[];
}

/**
 * Runs a local CLI with the prompt on stdin and returns stdout. Runs in the OS temp directory so the
 * CLI does not pick up the repository as project context. Rejects with a ProviderError when the
 * binary is missing, times out, or exits non-zero without output.
 */
export function runCliProcess(run: CliRun): Promise<string> {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env };
    for (const name of run.withoutEnvironment) Reflect.deleteProperty(environment, name);
    const child = spawn(run.command, [...run.args], {
      cwd: tmpdir(),
      env: environment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new ProviderError(`${run.label} request timed out`, run.provider));
    }, run.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new ProviderError(`${run.label} could not start: ${error.message}`, run.provider));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && stdout.trim() === "") {
        reject(new ProviderError(`${run.label} exited with code ${String(code)}: ${stderr.trim().slice(-300)}`, run.provider));
        return;
      }
      resolve(stdout);
    });
    child.stdin.on("error", () => undefined);
    child.stdin.end(run.stdin);
  });
}
