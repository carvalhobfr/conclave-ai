import { createHash } from "node:crypto";

import type { IndexedCodeUnit, RepositoryCodeIndex } from "../domain/code-index.js";
import type { ValidationEvidence, ValidationFinding } from "../domain/validation.js";

export function stableId(kind: string, ...parts: readonly string[]): string {
  return kind + "_" + createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 20);
}

function enclosingUnit(index: RepositoryCodeIndex, path: string, line: number): IndexedCodeUnit | undefined {
  return (index.files[path]?.symbolIds ?? [])
    .map((id) => index.units[id])
    .filter((unit): unit is IndexedCodeUnit => unit !== undefined && unit.startLine <= line && unit.endLine >= line)
    .sort((left, right) =>
      left.endLine - left.startLine - (right.endLine - right.startLine) ||
      right.startLine - left.startLine ||
      left.id.localeCompare(right.id))[0];
}

/**
 * Where a single-location finding sits in the code: its innermost enclosing symbol and the
 * text of the flagged line with whitespace collapsed. Neither changes when unrelated lines
 * are inserted or removed elsewhere in the file, and together they separate two defects of
 * the same kind in one file. Only its hash reaches a report.
 */
/** Name of the innermost symbol containing a line, qualified by its parent when it has one. */
export function enclosingSymbol(index: RepositoryCodeIndex, path: string, line: number): string | undefined {
  const unit = enclosingUnit(index, path, line);
  return unit === undefined ? undefined : (unit.parentSymbol === undefined ? "" : unit.parentSymbol + ".") + unit.symbol;
}

export function occurrenceAnchor(index: RepositoryCodeIndex, evidence: ValidationEvidence | undefined): string | undefined {
  if (evidence?.startLine === undefined) return undefined;
  const file = index.files[evidence.path];
  if (file === undefined) return undefined;
  const scope = enclosingSymbol(index, evidence.path, evidence.startLine) ?? "";
  const line = file.sourceText.split(/\r?\n/u)[evidence.startLine - 1] ?? "";
  return scope + "\0" + line.replace(/\s+/gu, " ").trim();
}

export interface FindingIdentities {
  readonly findings: readonly ValidationFinding[];
  /**
   * Anchored fingerprint to the fingerprint the same finding had before anchors existed, so a
   * review series that started on an older release keeps its lineage. One-to-one: an older
   * fingerprint is inherited by the first finding in source order only, so a defect added
   * beside an existing one is new rather than a second heir of the same history.
   */
  readonly legacyFingerprints: ReadonlyMap<string, string>;
}

function sourceOrder(left: ValidationFinding, right: ValidationFinding): number {
  const [a, b] = [left.evidence[0], right.evidence[0]];
  return (a?.path ?? "").localeCompare(b?.path ?? "") || (a?.startLine ?? 0) - (b?.startLine ?? 0);
}

/**
 * Gives every finding in a report its own fingerprint and id.
 *
 * `fingerprint` is the cross-review identity that lineage and feedback follow. `id` is the
 * handle other parts of the same report use, and is derived from it.
 *
 * Findings that are still indistinguishable after anchoring (the same statement repeated in
 * one symbol) are told apart by source order. The first keeps the unsuffixed fingerprint, so
 * removing one of them reports exactly one resolution.
 */
export function assignFindingIdentities(
  findings: readonly ValidationFinding[],
  anchors: ReadonlyMap<ValidationFinding, string>,
): FindingIdentities {
  const anchored = findings.map((finding) => {
    const anchor = anchors.get(finding);
    return anchor === undefined ? finding.fingerprint : stableId("fingerprint", finding.fingerprint, "anchor", anchor);
  });
  const groups = new Map<string, number[]>();
  for (const [position, fingerprint] of anchored.entries()) {
    groups.set(fingerprint, [...(groups.get(fingerprint) ?? []), position]);
  }
  const fingerprints = [...anchored];
  for (const [fingerprint, positions] of groups) {
    const ordered = [...positions].sort((left, right) => {
      const [a, b] = [findings[left], findings[right]];
      return (a === undefined || b === undefined ? 0 : sourceOrder(a, b)) || left - right;
    });
    for (const [occurrence, position] of ordered.entries()) {
      if (occurrence > 0) fingerprints[position] = stableId("fingerprint", fingerprint, "occurrence", String(occurrence));
    }
  }
  const identified = findings.map((finding, position) => {
    const fingerprint = fingerprints[position] ?? finding.fingerprint;
    return { ...finding, id: stableId("finding", fingerprint), fingerprint };
  });
  const legacyFingerprints = new Map<string, string>();
  const inherited = new Set<string>();
  const heirs = findings
    .map((finding, position) => ({ finding, fingerprint: identified[position]?.fingerprint ?? finding.fingerprint }))
    .filter((item) => anchors.has(item.finding))
    .sort((left, right) => sourceOrder(left.finding, right.finding) || left.fingerprint.localeCompare(right.fingerprint));
  for (const heir of heirs) {
    if (inherited.has(heir.finding.fingerprint)) continue;
    inherited.add(heir.finding.fingerprint);
    legacyFingerprints.set(heir.fingerprint, heir.finding.fingerprint);
  }
  return { findings: identified, legacyFingerprints };
}
