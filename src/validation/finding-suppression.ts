import type { RepositoryCodeIndex } from "../domain/code-index.js";
import type { ValidationFinding } from "../domain/validation.js";

// `// conclave-ignore`, `# conclave-ignore: discarded-error`, `/* conclave-ignore kind-a, kind-b */`
const DIRECTIVE = /\bconclave-ignore(?![\w-])(?:[:\s]+([a-z0-9-]+(?:\s*,\s*[a-z0-9-]+)*))?/iu;

function directiveKinds(line: string | undefined): readonly string[] | "all" | undefined {
  if (line === undefined) return undefined;
  const match = DIRECTIVE.exec(line);
  if (match === null) return undefined;
  const listed = match[1]?.split(",").map((kind) => kind.trim().toLowerCase()).filter((kind) => kind !== "");
  return listed === undefined || listed.length === 0 ? "all" : listed;
}

/**
 * Applies inline `conclave-ignore` directives found on a finding's line or the line above it.
 * A suppressed warning is kept as `info` with the reason, so the decision stays auditable in the
 * report while no longer affecting the verdict. Blocking findings can never be silenced inline.
 */
export function applyInlineSuppressions(
  index: RepositoryCodeIndex,
  findings: readonly ValidationFinding[],
): readonly ValidationFinding[] {
  const lineCache = new Map<string, readonly string[]>();
  const linesOf = (path: string): readonly string[] | undefined => {
    const cached = lineCache.get(path);
    if (cached !== undefined) return cached;
    const text = index.files[path]?.sourceText;
    if (text === undefined) return undefined;
    const lines = text.split(/\r?\n/u);
    lineCache.set(path, lines);
    return lines;
  };
  return findings.map((finding) => {
    if (finding.severity !== "warning") return finding;
    const evidence = finding.evidence[0];
    if (evidence?.startLine === undefined) return finding;
    const lines = linesOf(evidence.path);
    if (lines === undefined) return finding;
    for (const candidate of [lines[evidence.startLine - 1], lines[evidence.startLine - 2]]) {
      const kinds = directiveKinds(candidate);
      if (kinds === undefined) continue;
      if (kinds !== "all" && !kinds.includes(finding.kind)) continue;
      return {
        ...finding,
        severity: "info",
        detail: `${finding.detail} Suppressed by a conclave-ignore directive at ${evidence.path}:${String(evidence.startLine)}.`,
      };
    }
    return finding;
  });
}
