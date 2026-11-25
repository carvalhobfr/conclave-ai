import { describe, expect, it } from "vitest";
import { AgentRefused, invocation, openCodeConfig, replyText, supports } from "../src/agents.js";

const base = { instructions: "Do the job.", prompt: "Objective: x", worktree: "/tmp/wt" };

function argument(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

describe("agent invocations", () => {
  it("gives Claude Code edit tools without Bash, and no settings files", () => {
    const call = invocation({ ...base, member: { role: "driver", tool: "claude", model: "sonnet" }, mode: "edit" });
    expect(call.command).toBe("claude");
    expect(argument(call.args, "--tools")).toBe("Read,Edit,Write,Glob,Grep");
    expect(argument(call.args, "--permission-mode")).toBe("acceptEdits");
    expect(argument(call.args, "--setting-sources")).toBe("");
    expect(argument(call.args, "--model")).toBe("sonnet");
    expect(call.args).not.toContain("--allowedTools");
    expect(call.args.join(" ")).not.toMatch(/Bash|bypassPermissions|dangerously/);
    expect(call.stdin).toBe(base.prompt);
    expect(call.env).toEqual({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" });
  });

  it("gives a reading Claude Code read tools only", () => {
    const call = invocation({ ...base, member: { role: "navigator", tool: "claude" }, mode: "read" });
    expect(argument(call.args, "--tools")).toBe("Read,Glob,Grep");
    expect(argument(call.args, "--permission-mode")).toBe("dontAsk");
    expect(call.args).not.toContain("--model");
  });

  it("refuses Codex as an editor and runs it read-only otherwise", () => {
    expect(supports("codex", "edit")).toBe(false);
    expect(() => invocation({ ...base, member: { role: "driver", tool: "codex" }, mode: "edit" })).toThrow(AgentRefused);
    const call = invocation({ ...base, member: { role: "navigator", tool: "codex" }, mode: "read" });
    expect(argument(call.args, "--sandbox")).toBe("read-only");
    expect(argument(call.args, "-C")).toBe(base.worktree);
    expect(call.args.at(-1)).toBe("-");
    expect(call.stdin).toContain(base.instructions);
  });

  it("runs OpenCode with its own agents, the prompt after --", () => {
    const call = invocation({ ...base, member: { role: "driver", tool: "opencode" }, mode: "edit" });
    expect(argument(call.args, "--agent")).toBe("crew-edit");
    expect(argument(call.args, "--dir")).toBe(base.worktree);
    expect(call.args.at(-2)).toBe("--");
    expect(call.args).toContain("--pure");
    interface Agent { tools: Record<string, boolean>; permission: Record<string, string> }
    const config = JSON.parse(call.env["OPENCODE_CONFIG_CONTENT"] ?? "{}") as { permission: unknown; agent: Record<string, Agent> };
    expect(config.permission).toEqual({ "*": "deny" });
    expect(config.agent["crew-edit"]?.tools["bash"]).toBeUndefined();
    expect(config.agent["crew-edit"]?.tools["*"]).toBe(false);
    expect(config.agent["crew-read"]?.tools["edit"]).toBeUndefined();
    expect(config.agent["crew-read"]?.permission["edit"]).toBeUndefined();
    expect(openCodeConfig()).not.toMatch(/"bash":\s*(true|"allow")/);
  });
});

describe("agent replies", () => {
  it("reads Claude Code's JSON result and its errors", () => {
    expect(replyText("claude", JSON.stringify({ result: "Done.", is_error: false }))).toEqual({ text: "Done." });
    expect(replyText("claude", JSON.stringify({ result: "Limit reached", is_error: true })).error).toBe("Limit reached");
    expect(replyText("claude", "plain")).toEqual({ text: "plain" });
  });

  it("reads Codex's last agent message", () => {
    const lines = [
      { type: "thread.started", thread_id: "1" },
      { type: "item.completed", item: { type: "agent_message", text: "first" } },
      { type: "item.completed", item: { type: "agent_message", text: "last" } },
    ].map((line) => JSON.stringify(line)).join("\n");
    expect(replyText("codex", lines)).toEqual({ text: "last" });
  });

  it("joins OpenCode's text parts", () => {
    const lines = [
      { type: "text", part: { type: "text", text: "Hello " } },
      { type: "tool_use", part: { type: "tool" } },
      { type: "text", part: { type: "text", text: "world" } },
    ].map((line) => JSON.stringify(line)).join("\n");
    expect(replyText("opencode", lines)).toEqual({ text: "Hello world" });
  });
});
