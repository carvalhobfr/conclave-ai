import { describe, expect, it } from "vitest";

import { parseArguments } from "../src/cli-arguments.js";

describe("CLI argument parser", () => {
  it("applies the documented defaults when only a positional is given", () => {
    expect(parseArguments(["."])).toEqual({
      positionals: ["."],
      json: false,
      strategy: "hybrid",
      limit: 10,
      depth: 2,
      sourceBytes: 24_000,
      tokens: 6_000,
      graphOperation: "neighbors",
      debug: false,
      working: false,
      staged: false,
      branch: undefined,
      head: undefined,
      commit: undefined,
      objective: undefined,
      contractPath: undefined,
      previousReportPath: undefined,
      receiptPaths: [],
      attestedReceiptPaths: [],
      attestationRepository: undefined,
      attestationWorkflow: undefined,
      seriesId: undefined,
      newSeries: false,
    });
  });

  it("keeps positional order while flags are interleaved", () => {
    const parsed = parseArguments(["check", "--json", ".", "--depth", "3", "src/auth.ts"]);
    expect(parsed.positionals).toEqual(["check", ".", "src/auth.ts"]);
    expect(parsed.json).toBe(true);
    expect(parsed.depth).toBe(3);
  });

  it("reads every boolean flag", () => {
    const parsed = parseArguments(["--json", "--debug", "--working", "--staged", "--new-series"]);
    expect(parsed).toEqual(expect.objectContaining({
      json: true,
      debug: true,
      working: true,
      staged: true,
      newSeries: true,
    }));
  });

  it("treats --base and --branch as the same comparison base", () => {
    expect(parseArguments(["--base", "origin/master"]).branch).toBe("origin/master");
    expect(parseArguments(["--branch", "origin/master"]).branch).toBe("origin/master");
  });

  it("accumulates repeated --receipt values and keeps single-value options last-wins", () => {
    const parsed = parseArguments([
      "--receipt", "a.json",
      "--receipt", "b.json",
      "--objective", "first",
      "--objective", "second",
    ]);
    expect(parsed.receiptPaths).toEqual(["a.json", "b.json"]);
    expect(parsed.objective).toBe("second");
  });

  it("reads the full review lineage option set", () => {
    const parsed = parseArguments([
      "--head", "feature",
      "--commit", "abc1234",
      "--contract", "contract.json",
      "--previous-report", "previous.json",
      "--series", "series-7",
    ]);
    expect(parsed).toEqual(expect.objectContaining({
      head: "feature",
      commit: "abc1234",
      contractPath: "contract.json",
      previousReportPath: "previous.json",
      seriesId: "series-7",
    }));
  });

  it("rejects a value option that is followed by another option or by nothing", () => {
    for (const option of [
      "--base",
      "--branch",
      "--head",
      "--commit",
      "--objective",
      "--contract",
      "--previous-report",
      "--receipt",
      "--series",
    ]) {
      expect(() => parseArguments([option])).toThrow(`${option} requires a value`);
      expect(() => parseArguments([option, "--json"])).toThrow(`${option} requires a value`);
    }
  });

  it("accepts each retrieval strategy and rejects anything else", () => {
    for (const strategy of ["hybrid", "lexical", "semantic"] as const) {
      expect(parseArguments(["--strategy", strategy]).strategy).toBe(strategy);
    }
    expect(() => parseArguments(["--strategy", "vector"])).toThrow("--strategy must be hybrid, lexical, or semantic");
    expect(() => parseArguments(["--strategy"])).toThrow("--strategy must be hybrid, lexical, or semantic");
  });

  it("bounds --limit and --depth to their documented ranges", () => {
    expect(parseArguments(["--limit", "1"]).limit).toBe(1);
    expect(parseArguments(["--limit", "100"]).limit).toBe(100);
    for (const value of ["0", "101", "-1", "1.5", "many", ""]) {
      expect(() => parseArguments(["--limit", value])).toThrow("--limit must be an integer between 1 and 100");
    }

    expect(parseArguments(["--depth", "1"]).depth).toBe(1);
    expect(parseArguments(["--depth", "10"]).depth).toBe(10);
    for (const value of ["0", "11", "2.5", "deep"]) {
      expect(() => parseArguments(["--depth", value])).toThrow("--depth must be an integer between 1 and 10");
    }
  });

  it("requires a positive integer for the context budget options", () => {
    expect(parseArguments(["--source-bytes", "5000"]).sourceBytes).toBe(5_000);
    expect(parseArguments(["--tokens", "800"]).tokens).toBe(800);
    expect(() => parseArguments(["--source-bytes", "0"])).toThrow("--source-bytes must be a positive integer");
    expect(() => parseArguments(["--tokens", "-4"])).toThrow("--tokens must be a positive integer");
  });

  it("accepts every graph operation and names the valid set on failure", () => {
    for (const operation of [
      "neighbors",
      "callers",
      "callees",
      "imports",
      "exports",
      "references",
      "containing",
      "contained",
      "related",
    ] as const) {
      expect(parseArguments(["--operation", operation]).graphOperation).toBe(operation);
    }
    expect(() => parseArguments(["--operation", "siblings"])).toThrow(
      "--operation must be one of: neighbors, callers, callees, imports, exports, references, containing, contained, related",
    );
    expect(() => parseArguments(["--operation"])).toThrow("--operation must be one of:");
  });

  it("refuses an unknown option instead of treating it as a positional", () => {
    expect(() => parseArguments(["check", ".", "--deep"])).toThrow("Unknown option: --deep");
  });

  it("does not mistake a negative-looking positional for an option", () => {
    expect(parseArguments(["-5"]).positionals).toEqual(["-5"]);
  });

  it("returns empty defaults for an empty argument list", () => {
    const parsed = parseArguments([]);
    expect(parsed.positionals).toEqual([]);
    expect(parsed.receiptPaths).toEqual([]);
  });
});
