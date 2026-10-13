import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";

import createIgnore from "ignore";

import type { AuditFinding, AuditFindingApplicability, AuditReport } from "../domain/audit.js";

/**
 * Repository-declared noise management for `conclave audit`. Two committed files, both optional:
 *
 * `.conclave-baseline.json`  fingerprints that already existed when the baseline was taken.
 *                            They stay visible and stop failing the exit code.
 * `.conclave-audit.json`     applicability declarations: named paths (and optionally rules)
 *                            with a stated role and reason, such as deliberately invalid
 *                            parser fixtures.
 *
 * Neither file can hide a finding, classify it, or approve anything. Both are data: they are
 * parsed strictly, and nothing in them is executed or interpreted as an instruction.
 */

export const BASELINE_FILENAME = ".conclave-baseline.json";
export const APPLICABILITY_FILENAME = ".conclave-audit.json";

const MAX_POLICY_BYTES = 2_000_000;
const MAX_DECLARATIONS = 200;
const MAX_PATTERNS = 50;
const RULE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const ROLE = /^[a-z][a-z0-9-]{0,31}$/u;
const FINGERPRINT = /^[a-z_]{1,24}_[a-f0-9]{20}$/u;

export interface AuditBaselineEntry {
  readonly fingerprint: string;
  readonly ruleId: string;
  readonly path: string;
}

export interface AuditBaseline {
  readonly schemaVersion: 1;
  readonly createdAt: string;
  /** Snapshot the baseline was taken from. Informational. */
  readonly snapshot: string;
  readonly analyzerVersion: string;
  readonly findings: readonly AuditBaselineEntry[];
}

export interface ApplicabilityDeclaration {
  /** Gitignore-style patterns, relative to the repository root. */
  readonly paths: readonly string[];
  /** Limits the declaration to these rules. Absent means every rule. */
  readonly rules?: readonly string[];
  readonly role: string;
  readonly reason: string;
  readonly issueProposals: boolean;
  readonly gate: boolean;
}

export interface AuditPolicy {
  readonly baseline?: { readonly path: string; readonly value: AuditBaseline };
  readonly applicability?: { readonly path: string; readonly declarations: readonly ApplicabilityDeclaration[] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], where: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) throw new Error(`${where} has unsupported field(s): ${unknown.join(", ")}`);
}

function text(value: unknown, where: string, max: number): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) throw new Error(`${where} must be a non-empty string of at most ${String(max)} characters`);
  return value.trim();
}

function strings(value: unknown, where: string, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max) throw new Error(`${where} must be a list of 1 to ${String(max)} strings`);
  return value.map((item, position) => text(item, `${where}[${String(position)}]`, 300));
}

export function parseBaseline(value: unknown, file = BASELINE_FILENAME): AuditBaseline {
  if (!isRecord(value)) throw new Error(`${file} must be a JSON object`);
  onlyKeys(value, ["schemaVersion", "createdAt", "snapshot", "analyzerVersion", "findings"], file);
  if (value["schemaVersion"] !== 1) throw new Error(`${file} has schemaVersion ${JSON.stringify(value["schemaVersion"])}; this Conclave reads version 1`);
  if (!Array.isArray(value["findings"])) throw new Error(`${file}: findings must be a list`);
  const seen = new Set<string>();
  const findings = value["findings"].map((item, position): AuditBaselineEntry => {
    const where = `${file}: findings[${String(position)}]`;
    if (!isRecord(item)) throw new Error(`${where} must be an object`);
    onlyKeys(item, ["fingerprint", "ruleId", "path"], where);
    const fingerprint = text(item["fingerprint"], `${where}.fingerprint`, 80);
    if (!FINGERPRINT.test(fingerprint)) throw new Error(`${where}.fingerprint is not a Conclave fingerprint`);
    if (seen.has(fingerprint)) throw new Error(`${where}.fingerprint is listed twice`);
    seen.add(fingerprint);
    return { fingerprint, ruleId: text(item["ruleId"], `${where}.ruleId`, 64), path: text(item["path"], `${where}.path`, 1000) };
  });
  return {
    schemaVersion: 1,
    createdAt: text(value["createdAt"], `${file}: createdAt`, 40),
    snapshot: text(value["snapshot"], `${file}: snapshot`, 80),
    analyzerVersion: text(value["analyzerVersion"], `${file}: analyzerVersion`, 40),
    findings,
  };
}

export function parseApplicability(value: unknown, file = APPLICABILITY_FILENAME): readonly ApplicabilityDeclaration[] {
  if (!isRecord(value)) throw new Error(`${file} must be a JSON object`);
  onlyKeys(value, ["schemaVersion", "applicability"], file);
  if (value["schemaVersion"] !== 1) throw new Error(`${file} has schemaVersion ${JSON.stringify(value["schemaVersion"])}; this Conclave reads version 1`);
  const declarations = value["applicability"];
  if (!Array.isArray(declarations) || declarations.length > MAX_DECLARATIONS) throw new Error(`${file}: applicability must be a list of at most ${String(MAX_DECLARATIONS)} declarations`);
  return declarations.map((item, position): ApplicabilityDeclaration => {
    const where = `${file}: applicability[${String(position)}]`;
    if (!isRecord(item)) throw new Error(`${where} must be an object`);
    onlyKeys(item, ["paths", "rules", "role", "reason", "issueProposals", "gate"], where);
    const paths = strings(item["paths"], `${where}.paths`, MAX_PATTERNS);
    // A declaration names specific places. One that covers the whole repository would be a
    // way to silence the audit, which is what the baseline and `--fail-on` exist to make explicit.
    for (const pattern of paths) {
      if (pattern.startsWith("!")) throw new Error(`${where}.paths does not accept negated patterns`);
      if (/^(?:\/|\*+\/?|\*\*\/\*+|\.\/?)$/u.test(pattern)) throw new Error(`${where}.paths must name specific paths; ${JSON.stringify(pattern)} matches the whole repository`);
    }
    const rules = item["rules"] === undefined ? undefined : strings(item["rules"], `${where}.rules`, 50);
    for (const rule of rules ?? []) if (!RULE_ID.test(rule)) throw new Error(`${where}.rules: ${JSON.stringify(rule)} is not a rule id`);
    const role = text(item["role"], `${where}.role`, 32);
    if (!ROLE.test(role)) throw new Error(`${where}.role must be a short lowercase label such as "fixture"`);
    for (const flag of ["issueProposals", "gate"] as const) {
      if (item[flag] !== undefined && typeof item[flag] !== "boolean") throw new Error(`${where}.${flag} must be true or false`);
    }
    return {
      paths,
      ...(rules === undefined ? {} : { rules }),
      role,
      reason: text(item["reason"], `${where}.reason`, 300),
      // Stated defaults: a declared location stays in the exit code and out of issue drafting
      // unless the declaration says otherwise.
      issueProposals: item["issueProposals"] === true,
      gate: item["gate"] !== false,
    };
  });
}

async function readPolicyFile(root: string, name: string): Promise<unknown> {
  const path = join(root, name);
  const details = await lstat(path).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (details === undefined) return undefined;
  if (!details.isFile()) throw new Error(`${name} must be a regular file`);
  if (details.size > MAX_POLICY_BYTES) throw new Error(`${name} exceeds ${String(MAX_POLICY_BYTES)} bytes`);
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (error) {
    throw new Error(`${name} is not valid JSON`, { cause: error });
  }
}

export interface LoadPolicyOptions {
  /** False to audit as if no baseline existed. */
  readonly baseline?: boolean;
}

/** Reads the repository's policy files. An invalid file fails the audit instead of being ignored. */
export async function loadAuditPolicy(root: string, options: LoadPolicyOptions = {}): Promise<AuditPolicy> {
  const [baseline, applicability] = await Promise.all([
    options.baseline === false ? undefined : readPolicyFile(root, BASELINE_FILENAME),
    readPolicyFile(root, APPLICABILITY_FILENAME),
  ]);
  return {
    ...(baseline === undefined ? {} : { baseline: { path: BASELINE_FILENAME, value: parseBaseline(baseline) } }),
    ...(applicability === undefined ? {} : { applicability: { path: APPLICABILITY_FILENAME, declarations: parseApplicability(applicability) } }),
  };
}

type Unannotated = Omit<AuditFinding, "baseline" | "applicability">;

/** Annotates findings with the policy that covers them. Removes and reorders nothing. */
export function applyAuditPolicy(findings: readonly Unannotated[], policy: AuditPolicy): { readonly findings: readonly AuditFinding[]; readonly summary: AuditReport["policy"] } {
  const baselined = new Set(policy.baseline?.value.findings.map((entry) => entry.fingerprint));
  const matchers = (policy.applicability?.declarations ?? []).map((declaration) => ({ declaration, matcher: createIgnore().add([...declaration.paths]) }));
  let baselineMatched = 0;
  let applicabilityMatched = 0;
  const annotated = findings.map((finding): AuditFinding => {
    const inBaseline = baselined.has(finding.fingerprint);
    if (inBaseline) baselineMatched += 1;
    // Every file the finding involves must be covered: a cycle that leaves the fixtures is not a fixture problem.
    const involved = [...new Set([finding.location.path, ...finding.evidence.map((item) => item.path)])].filter((path) => path !== "");
    const position = involved.length === 0 ? -1 : matchers.findIndex(({ declaration, matcher }) =>
      (declaration.rules === undefined || declaration.rules.includes(finding.ruleId)) && involved.every((path) => matcher.ignores(path)));
    const matched = matchers[position]?.declaration;
    let applicability: AuditFindingApplicability | undefined;
    if (matched !== undefined) {
      applicabilityMatched += 1;
      applicability = { role: matched.role, issueProposals: matched.issueProposals, gate: matched.gate, reason: matched.reason, source: `${policy.applicability?.path ?? APPLICABILITY_FILENAME}#${String(position)}` };
    }
    return {
      ...finding,
      ...(inBaseline && policy.baseline !== undefined ? { baseline: { createdAt: policy.baseline.value.createdAt } } : {}),
      ...(applicability === undefined ? {} : { applicability }),
    };
  });
  return {
    findings: annotated,
    summary: {
      ...(policy.baseline === undefined ? {} : { baseline: { path: policy.baseline.path, createdAt: policy.baseline.value.createdAt, entries: policy.baseline.value.findings.length, matched: baselineMatched } }),
      ...(policy.applicability === undefined ? {} : { applicability: { path: policy.applicability.path, declarations: policy.applicability.declarations.length, matched: applicabilityMatched } }),
    },
  };
}

/** Whether `--fail-on` considers the finding. */
export function isGated(finding: AuditFinding): boolean {
  // A model hypothesis is unconfirmed and can differ between runs, so it never fails a build.
  if (finding.origin === "ai-hypothesis") return false;
  return finding.suppression === undefined && finding.baseline === undefined && finding.applicability?.gate !== false;
}

/**
 * A baseline of every finding the report observed that is not suppressed inline. Fingerprints,
 * rule ids and paths only; no source text and no titles.
 */
export function createBaseline(report: AuditReport): AuditBaseline {
  return {
    schemaVersion: 1,
    createdAt: report.generatedAt,
    snapshot: report.snapshot.id,
    analyzerVersion: report.analyzer.version,
    findings: report.findings
      .filter((finding) => finding.suppression === undefined)
      .map((finding) => ({ fingerprint: finding.fingerprint, ruleId: finding.ruleId, path: finding.location.path }))
      .sort((left, right) => left.path.localeCompare(right.path) || left.fingerprint.localeCompare(right.fingerprint)),
  };
}
