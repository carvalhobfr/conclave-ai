import type { RetrievalStrategy } from "./retrieval/hybrid-retriever.js";

export type GraphOperation =
  | "neighbors"
  | "callers"
  | "callees"
  | "imports"
  | "exports"
  | "references"
  | "containing"
  | "contained"
  | "related";

export interface ParsedArguments {
  readonly positionals: readonly string[];
  readonly json: boolean;
  readonly strategy: RetrievalStrategy;
  readonly limit: number;
  readonly depth: number;
  readonly sourceBytes: number;
  readonly tokens: number;
  readonly graphOperation: GraphOperation;
  readonly debug: boolean;
  readonly working: boolean;
  readonly staged: boolean;
  readonly branch: string | undefined;
  readonly head: string | undefined;
  readonly commit: string | undefined;
  readonly objective: string | undefined;
  readonly contractPath: string | undefined;
  readonly previousReportPath: string | undefined;
  readonly receiptPaths: readonly string[];
  readonly attestedReceiptPaths: readonly string[];
  readonly attestationRepository: string | undefined;
  readonly attestationWorkflow: string | undefined;
  readonly seriesId: string | undefined;
  readonly newSeries: boolean;
}

const GRAPH_OPERATIONS: readonly GraphOperation[] = [
  "neighbors",
  "callers",
  "callees",
  "imports",
  "exports",
  "references",
  "containing",
  "contained",
  "related",
];

export function parseArguments(args: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  let json = false;
  let strategy: RetrievalStrategy = "hybrid";
  let limit = 10;
  let depth = 2;
  let sourceBytes = 24_000;
  let tokens = 6_000;
  let graphOperation: GraphOperation = "neighbors";
  let debug = false;
  let working = false;
  let staged = false;
  let branch: string | undefined;
  let head: string | undefined;
  let commit: string | undefined;
  let objective: string | undefined;
  let contractPath: string | undefined;
  let previousReportPath: string | undefined;
  const receiptPaths: string[] = [];
  const attestedReceiptPaths: string[] = [];
  let attestationRepository: string | undefined;
  let attestationWorkflow: string | undefined;
  let seriesId: string | undefined;
  let newSeries = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--debug") {
      debug = true;
      continue;
    }
    if (argument === "--working") {
      working = true;
      continue;
    }
    if (argument === "--staged") {
      staged = true;
      continue;
    }
    if (argument === "--new-series") {
      newSeries = true;
      continue;
    }
    if (argument === "--base" || argument === "--branch" || argument === "--head" || argument === "--commit" || argument === "--objective" || argument === "--contract" || argument === "--previous-report" || argument === "--receipt" || argument === "--series" || argument === "--attested-receipt" || argument === "--attestation-repository" || argument === "--attestation-workflow") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(argument + " requires a value");
      }
      if (argument === "--base" || argument === "--branch") branch = value;
      else if (argument === "--head") head = value;
      else if (argument === "--commit") commit = value;
      else if (argument === "--objective") objective = value;
      else if (argument === "--contract") contractPath = value;
      else if (argument === "--previous-report") previousReportPath = value;
      else if (argument === "--receipt") receiptPaths.push(value);
      else if (argument === "--attested-receipt") attestedReceiptPaths.push(value);
      else if (argument === "--attestation-repository") attestationRepository = value;
      else if (argument === "--attestation-workflow") attestationWorkflow = value;
      else seriesId = value;
      index += 1;
      continue;
    }
    if (argument === "--strategy") {
      const value = args[index + 1];
      if (value !== "hybrid" && value !== "lexical" && value !== "semantic") {
        throw new Error("--strategy must be hybrid, lexical, or semantic");
      }
      strategy = value;
      index += 1;
      continue;
    }
    if (argument === "--limit") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0 || value > 100) {
        throw new Error("--limit must be an integer between 1 and 100");
      }
      limit = value;
      index += 1;
      continue;
    }
    if (argument === "--depth") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0 || value > 10) {
        throw new Error("--depth must be an integer between 1 and 10");
      }
      depth = value;
      index += 1;
      continue;
    }
    if (argument === "--source-bytes" || argument === "--tokens") {
      const value = Number(args[index + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${argument} must be a positive integer`);
      }
      if (argument === "--source-bytes") sourceBytes = value;
      else tokens = value;
      index += 1;
      continue;
    }
    if (argument === "--operation") {
      const value = args[index + 1];
      if (value === undefined || !GRAPH_OPERATIONS.includes(value as GraphOperation)) {
        throw new Error(`--operation must be one of: ${GRAPH_OPERATIONS.join(", ")}`);
      }
      graphOperation = value as GraphOperation;
      index += 1;
      continue;
    }
    if (argument?.startsWith("--") === true) {
      throw new Error(`Unknown option: ${argument}`);
    }
    if (argument !== undefined) {
      positionals.push(argument);
    }
  }
  return {
    positionals,
    json,
    strategy,
    limit,
    depth,
    sourceBytes,
    tokens,
    graphOperation,
    debug,
    working,
    staged,
    branch,
    head,
    commit,
    objective,
    contractPath,
    previousReportPath,
    receiptPaths,
    attestedReceiptPaths,
    attestationRepository,
    attestationWorkflow,
    seriesId,
    newSeries,
  };
}
