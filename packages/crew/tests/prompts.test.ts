import { describe, expect, it } from "vitest";
import { DIFF_LIMIT, fixPrompt, parseProblems, reviewPrompt } from "../src/prompts.js";

const task = { id: "t-1", objective: "Add subtraction", criteria: ["sub(5, 3) is 2"], createdAt: "2026-11-25T00:00:00.000Z" };

describe("navigator problems", () => {
  it("keeps problems with a file and a line and drops the rest", () => {
    const reply = "```json\n" + JSON.stringify({ problems: [
      { severity: "blocking", file: "math.js", line: 4, message: "Wrong sign" },
      { severity: "warning", file: "math.js", message: "No line" },
      { severity: "info", file: "", line: 2, message: "No file" },
      { severity: "loud", file: "math.js", line: 9, message: "Unknown severity becomes a warning" },
      { severity: "info", file: "math.js", line: 0, message: "Line zero" },
    ] }) + "\n```";
    const parsed = parseProblems(reply);
    expect(parsed.readable).toBe(true);
    expect(parsed.dropped).toBe(3);
    expect(parsed.problems).toEqual([
      { severity: "blocking", file: "math.js", line: 4, message: "Wrong sign" },
      { severity: "warning", file: "math.js", line: 9, message: "Unknown severity becomes a warning" },
    ]);
  });

  it("says when the reply can't be read", () => {
    expect(parseProblems("Looks fine to me").readable).toBe(false);
    expect(parseProblems("{not json}").readable).toBe(false);
    expect(parseProblems('{"issues": []}').readable).toBe(false);
    expect(parseProblems('{"problems": []}')).toEqual({ problems: [], dropped: 0, readable: true });
  });
});

describe("prompts", () => {
  it("cuts a long diff and says so", () => {
    const prompt = reviewPrompt(task, "x".repeat(DIFF_LIMIT + 10));
    expect(prompt).toContain("cut at");
    expect(prompt).toContain("sub(5, 3) is 2");
  });

  it("gives the driver every source of problems", () => {
    const prompt = fixPrompt(task, {
      problems: [{ severity: "blocking", file: "math.js", line: 4, message: "Wrong sign" }],
      conclaveHandoff: "Conclave says: add tests",
      testsFailure: "1 failed",
    });
    expect(prompt).toContain("[blocking] math.js:4: Wrong sign");
    expect(prompt).toContain("Conclave says: add tests");
    expect(prompt).toContain("1 failed");
  });
});
