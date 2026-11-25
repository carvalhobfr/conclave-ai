import { runProcess } from "./process.js";
import type { AgentMode, AgentTool, CrewMember } from "./types.js";

export interface AgentInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: string;
}

export interface AgentRequest {
  readonly member: CrewMember;
  readonly mode: AgentMode;
  readonly instructions: string;
  readonly prompt: string;
  readonly worktree: string;
  readonly timeoutMs: number;
  readonly shouldCancel?: () => boolean;
}

export interface AgentReply {
  readonly ok: boolean;
  readonly text: string;
  readonly error?: string;
  readonly cancelled: boolean;
}

/** Runs one agent turn. The real one starts a CLI; tests pass their own. */
export type AgentRunner = (request: AgentRequest) => Promise<AgentReply>;

export class AgentRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentRefused";
  }
}

/** Tools Claude Code gets. No Bash, no web: edits go through Edit/Write, which accept-edits mode limits to the worktree. */
const CLAUDE_EDIT_TOOLS = "Read,Edit,Write,Glob,Grep";
const CLAUDE_READ_TOOLS = "Read,Glob,Grep";

export const OPENCODE_CONFIG_VARIABLE = "OPENCODE_CONFIG_CONTENT";

/**
 * Whether a tool can take a role in a mode. Codex can't edit without being able to run shell commands
 * (its workspace-write sandbox runs them), and Crew's agents only edit, so Codex only reviews.
 */
export function supports(tool: AgentTool, mode: AgentMode): boolean {
  return !(tool === "codex" && mode === "edit");
}

export function invocation(request: Pick<AgentRequest, "member" | "mode" | "instructions" | "prompt" | "worktree">): AgentInvocation {
  const { member, mode, instructions, prompt, worktree } = request;
  if (!supports(member.tool, mode)) {
    throw new AgentRefused(`${member.tool} can't be restricted to editing files without running commands, so it can only review`);
  }
  const model = member.model !== undefined && member.model !== "" ? member.model : undefined;
  switch (member.tool) {
    case "claude": {
      const args = [
        "-p", "--output-format", "json",
        // No settings files: a repository's own .claude settings could add hooks, which run commands.
        "--setting-sources", "",
        "--strict-mcp-config", "--disable-slash-commands", "--no-session-persistence",
        "--tools", mode === "edit" ? CLAUDE_EDIT_TOOLS : CLAUDE_READ_TOOLS,
        // Edits inside the working directory are accepted; anything outside it would need a prompt, which -p refuses.
        "--permission-mode", mode === "edit" ? "acceptEdits" : "dontAsk",
        "--append-system-prompt", instructions,
      ];
      if (model !== undefined) args.push("--model", model);
      return { command: "claude", args, env: { CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" }, stdin: prompt };
    }
    case "codex": {
      const args = [
        "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check",
        "--ignore-user-config", "--ignore-rules", "--color", "never", "--ephemeral",
        "-C", worktree,
      ];
      if (model !== undefined) args.push("-m", model);
      args.push("-");
      return { command: "codex", args, env: {}, stdin: `${instructions}\n\n${prompt}` };
    }
    case "opencode": {
      const agent = mode === "edit" ? "crew-edit" : "crew-read";
      const args = ["run", "--format", "json", "--agent", agent, "--pure", "--dir", worktree];
      if (model !== undefined) args.push("-m", model);
      args.push("--", `${instructions}\n\n${prompt}`);
      return { command: "opencode", args, env: { [OPENCODE_CONFIG_VARIABLE]: openCodeConfig() }, stdin: "" };
    }
  }
}

/** Two agents with every tool off except reading, and editing for `crew-edit`; every other permission denied. */
export function openCodeConfig(): string {
  const read = { read: true, glob: true, grep: true, list: true };
  const readPermission = { "*": "deny", read: "allow", glob: "allow", grep: "allow", list: "allow" };
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    autoupdate: false,
    share: "disabled",
    permission: { "*": "deny" },
    agent: {
      "crew-edit": {
        mode: "primary",
        description: "Conclave Crew: edits files in its worktree, runs nothing",
        tools: { "*": false, ...read, edit: true, write: true, patch: true },
        permission: { ...readPermission, edit: "allow" },
      },
      "crew-read": {
        mode: "primary",
        description: "Conclave Crew: reads files in its worktree, changes nothing",
        tools: { "*": false, ...read },
        permission: readPermission,
      },
    },
  });
}

/** The agent's final text from its CLI's output. */
export function replyText(tool: AgentTool, stdout: string): { text: string; error?: string } {
  if (tool === "claude") {
    const object = parseObject(stdout.trim());
    if (object === undefined) return { text: stdout.trim() };
    const result = typeof object["result"] === "string" ? object["result"] : "";
    return object["is_error"] === true ? { text: result, error: result === "" ? "Claude Code reported an error" : result } : { text: result };
  }
  const lines = stdout.split("\n").map((line) => parseObject(line.trim())).filter((item) => item !== undefined);
  if (tool === "codex") {
    const messages = lines
      .map((event) => object(event["item"]))
      .filter((item) => item !== undefined && item["type"] === "agent_message" && typeof item["text"] === "string")
      .map((item) => String(item?.["text"]));
    const failure = lines.find((event) => event["type"] === "error" || event["type"] === "turn.failed");
    const last = messages.at(-1) ?? "";
    return failure === undefined ? { text: last } : { text: last, error: JSON.stringify(failure).slice(0, 500) };
  }
  const texts = lines
    .map((event) => object(event["part"]))
    .filter((part) => part !== undefined && part["type"] === "text" && typeof part["text"] === "string")
    .map((part) => String(part?.["text"]));
  const failure = lines.find((event) => event["type"] === "error");
  const text = texts.join("");
  return failure === undefined ? { text } : { text, error: JSON.stringify(failure).slice(0, 500) };
}

/** The real runner: starts the member's CLI in the worktree. */
export const cliAgentRunner: AgentRunner = async (request) => {
  const call = invocation(request);
  const result = await runProcess(call.command, call.args, {
    cwd: request.worktree,
    env: { ...process.env, ...call.env },
    input: call.stdin,
    timeoutMs: request.timeoutMs,
    ...(request.shouldCancel === undefined ? {} : { shouldCancel: request.shouldCancel }),
  });
  const reply = replyText(request.member.tool, result.stdout);
  if (result.cancelled) return { ok: false, text: reply.text, error: "stopped", cancelled: true };
  if (result.timedOut) return { ok: false, text: reply.text, error: "timed out", cancelled: false };
  if (result.exitCode !== 0 || reply.error !== undefined) {
    const detail = reply.error ?? (result.stderr.trim().split("\n").slice(-5).join("\n") || `exit code ${String(result.exitCode)}`);
    return { ok: false, text: reply.text, error: detail, cancelled: false };
  }
  return { ok: true, text: reply.text, cancelled: false };
};

function parseObject(text: string): Record<string, unknown> | undefined {
  if (!text.startsWith("{")) return undefined;
  try {
    return object(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
