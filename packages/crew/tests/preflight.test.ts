import { describe, expect, it } from "vitest";
import { compare, preflight, type VersionProbe } from "../src/preflight.js";
import type { Crew } from "../src/types.js";

const crew: Crew = { members: [{ role: "driver", tool: "claude" }, { role: "navigator", tool: "codex" }] };

function probe(versions: Record<string, string | undefined>): { probe: VersionProbe; asked: string[] } {
  const asked: string[] = [];
  return { asked, probe: (command) => { asked.push(command); return Promise.resolve(versions[command]); } };
}

describe("preflight", () => {
  it("passes when Conclave and every crew CLI answer", async () => {
    const fake = probe({ conclave: "0.25.0", claude: "2.1.304", codex: "0.9.0" });
    const result = await preflight(crew, { command: "conclave", args: [] }, fake.probe);
    expect(result).toEqual({ problems: [], conclaveVersion: "0.25.0" });
    expect(fake.asked).toEqual(["conclave", "claude", "codex"]);
  });

  it("names what is missing or too old before any agent runs", async () => {
    const result = await preflight(crew, { command: "conclave", args: [] }, probe({ conclave: "0.24.9", claude: "2.1.304" }).probe);
    expect(result.problems).toHaveLength(2);
    expect(result.problems[0]).toMatch(/0\.24\.9 is too old/);
    expect(result.problems[1]).toMatch(/Codex/);
    const missing = await preflight(crew, { command: "conclave", args: [] }, probe({ claude: "1", codex: "1" }).probe);
    expect(missing.problems[0]).toMatch(/npm install -g conclave-ai/);
  });

  it("compares versions by number", () => {
    expect(compare("0.25.0", "0.25.0")).toBe(0);
    expect(compare("0.26.1", "0.25.9")).toBeGreaterThan(0);
    expect(compare("0.9.0", "0.25.0")).toBeLessThan(0);
  });
});
