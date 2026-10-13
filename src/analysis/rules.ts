import { dirname, extname, posix } from "node:path";

import type { SourceLanguage } from "../domain/repository.js";
import { resolveImport } from "../graph/code-graph.js";
import { analyzeFileDefects, type SourceDefect } from "../validation/source-defects.js";
import type { AnalysisContext, AnalysisFile, AnalysisRule, RuleMatch } from "./rule.js";

const JS_FAMILY: readonly SourceLanguage[] = ["typescript", "tsx", "javascript", "jsx"];
const STRUCTURED: readonly SourceLanguage[] = [...JS_FAMILY, "python", "java"];
const MAX_DIAGNOSTICS_PER_FILE = 20;
const MAX_CYCLE_EVIDENCE = 20;

/** All defect observations of one file, computed once however many rules read them. */
function fileDefects(context: AnalysisContext, file: AnalysisFile, sourceText: string): readonly SourceDefect[] | undefined {
  return context.memo(`defects:${file.path}`, () => analyzeFileDefects(file, sourceText)?.defects);
}

/**
 * A rule over the shared defect analysis. In change scope the title keeps the wording review
 * reports have always used, because the title is part of a finding's fingerprint.
 */
function defectRule(
  id: SourceDefect["kind"],
  languages: readonly SourceLanguage[],
  repositoryTitle: string,
  limitation: string,
): AnalysisRule {
  return {
    id,
    category: id === "inconsistent-key" ? "correctness" : "reliability",
    languages,
    scopes: ["change", "repository"],
    limitation,
    run(context) {
      const matches: RuleMatch[] = [];
      const filesExamined: string[] = [];
      for (const { file, indexed } of context.filesFor(languages)) {
        const defects = fileDefects(context, file, indexed.sourceText);
        if (defects === undefined) continue;
        filesExamined.push(file.path);
        for (const [sequence, defect] of defects.entries()) {
          if (defect.kind !== id) continue;
          const title = context.scope === "repository" ? repositoryTitle : defect.title;
          matches.push({
            ruleId: id,
            title,
            detail: defect.detail,
            remediation: defect.remediation,
            evidence: [context.scope === "repository" ? { ...defect.evidence, reason: title } : defect.evidence],
            sequence,
          });
        }
      }
      return { matches, filesExamined };
    },
  };
}

export const parserDiagnosticRule: AnalysisRule = {
  id: "parser-diagnostic",
  category: "parse",
  languages: STRUCTURED,
  scopes: ["change", "repository"],
  limitation: "Reports what the syntax parser rejected. Type errors and failures that only a compiler or runtime detects are not covered.",
  run(context) {
    const matches: RuleMatch[] = [];
    const filesExamined: string[] = [];
    for (const { file, indexed } of context.filesFor(STRUCTURED)) {
      filesExamined.push(file.path);
      for (const [sequence, diagnostic] of indexed.diagnostics.slice(0, MAX_DIAGNOSTICS_PER_FILE).entries()) {
        matches.push({
          ruleId: "parser-diagnostic",
          title: context.scope === "repository" ? "Source has a parser diagnostic" : "Changed source has a parser diagnostic",
          detail: diagnostic.message,
          remediation: "Repair the syntax or parser-visible structural error before accepting the resolution.",
          evidence: [{ path: file.path, startLine: diagnostic.line, endLine: diagnostic.line, reason: "Language parser diagnostic" }],
          sequence,
        });
      }
    }
    return { matches, filesExamined };
  },
};

export const discardedErrorRule = defectRule(
  "discarded-error",
  STRUCTURED,
  "Empty catch block",
  "Finds handlers with no statements. It does not judge whether ignoring the error is correct, and does not see errors discarded in other ways.",
);

export const unreleasedResourceRule = defectRule(
  "unreleased-resource",
  STRUCTURED,
  "Resource has no matching cleanup candidate in this file",
  "Looks for a syntactic cleanup candidate in the same file. Cleanup delegated to another module, or a registration meant to be permanent, is reported too; a match does not prove a leak.",
);

export const inconsistentKeyRule = defectRule(
  "inconsistent-key",
  JS_FAMILY,
  "Storage call uses a different key from named keys in this file",
  "Compares literal and named storage keys inside one file. Distinct keys may be intentional, and keys built at run time are not seen.",
);

function importBase(importerPath: string, source: string): string {
  return posix.normalize(posix.join(dirname(importerPath).replaceAll("\\", "/"), source));
}

const MODULE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const ASSET_EXTENSIONS = new Set([
  ".css", ".scss", ".sass", ".less", ".json", ".svg", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico",
  ".html", ".md", ".txt", ".yaml", ".yml", ".vue", ".svelte", ".wasm", ".graphql", ".gql", ".node",
]);

const TARGET_SUFFIXES = [...MODULE_EXTENSIONS, ".d.ts", ".d.mts", ".d.cts"];

/**
 * True when the index itself says why the target is absent (ignored build output, an asset
 * with no parser, a file withheld for safety). Such an import is not broken; it points outside
 * what was analyzed.
 */
function targetIsOutsideAnalysis(context: AnalysisContext, base: string): boolean {
  const extension = extname(base).toLowerCase();
  // A specifier naming a file type that is never indexed (`./styles.css`, `./data.json`).
  if (ASSET_EXTENSIONS.has(extension)) return true;
  const stem = MODULE_EXTENSIONS.has(extension) ? base.slice(0, -extension.length) : base;
  // Only a file the specifier could actually name explains the import: `foo.test.ts` being
  // excluded says nothing about `./foo`.
  const candidates = new Set([base, ...TARGET_SUFFIXES.flatMap((suffix) => [`${stem}${suffix}`, `${base}/index${suffix}`])]);
  return (context.index.coverage?.gaps ?? []).some((gap) =>
    candidates.has(gap.path) ||
    (gap.path.endsWith("/") && `${base}/`.startsWith(gap.path)));
}

export const unresolvedImportRule: AnalysisRule = {
  id: "unresolved-import",
  category: "correctness",
  languages: JS_FAMILY,
  scopes: ["repository"],
  limitation: "Resolution is file based. Path aliases, package exports, generated files and bundler-specific resolution are not modeled, so an import they satisfy can be reported. Without recorded index coverage the rule cannot tell an excluded target from a missing one.",
  run(context) {
    const matches: RuleMatch[] = [];
    const filesExamined: string[] = [];
    for (const { file, indexed } of context.filesFor(JS_FAMILY)) {
      filesExamined.push(file.path);
      let sequence = 0;
      for (const reference of indexed.imports) {
        if (!reference.source.startsWith(".")) continue;
        const resolution = resolveImport(file.path, reference.source, indexed.language, context.index.files);
        if (resolution.status === "resolved") continue;
        if (resolution.status === "unresolved" && targetIsOutsideAnalysis(context, importBase(file.path, reference.source))) continue;
        const ambiguous = resolution.status === "ambiguous";
        const title = ambiguous ? "Relative import matches more than one source file" : "Relative import does not resolve to an analyzed file";
        matches.push({
          ruleId: "unresolved-import",
          title,
          detail: ambiguous
            ? `${reference.source} could be emitted by ${resolution.candidates.join(" or ")}. The graph draws no edge for it.`
            : `${reference.source} names no file in the analyzed snapshot, and no exclusion explains its absence.`,
          remediation: ambiguous
            ? "Rename one of the sources or import it by its own extension so the target is unambiguous."
            : "Check the specifier. If a path alias, generated file or build step provides the module, this report is expected.",
          evidence: [{ path: file.path, startLine: reference.line, endLine: reference.line, reason: title }],
          sequence,
        });
        sequence += 1;
      }
    }
    return { matches, filesExamined };
  },
};

interface ImportEdge {
  readonly to: string;
  readonly line: number;
}

/** Runtime import edges between indexed files; type-only imports create no load-time dependency. */
function runtimeImports(context: AnalysisContext): ReadonlyMap<string, readonly ImportEdge[]> {
  const edges = new Map<string, ImportEdge[]>();
  for (const { file, indexed } of context.filesFor(JS_FAMILY)) {
    const outgoing: ImportEdge[] = [];
    for (const reference of indexed.imports) {
      if (reference.bindings.length > 0 && reference.bindings.every((binding) => binding.typeOnly)) continue;
      const resolution = resolveImport(file.path, reference.source, indexed.language, context.index.files);
      if (resolution.status === "resolved" && !outgoing.some((edge) => edge.to === resolution.path)) {
        outgoing.push({ to: resolution.path, line: reference.line });
      }
    }
    edges.set(file.path, outgoing);
  }
  return edges;
}

/** Tarjan's algorithm, iterative so a deep import chain cannot exhaust the stack. */
function stronglyConnected(edges: ReadonlyMap<string, readonly ImportEdge[]>): readonly (readonly string[])[] {
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;
  for (const root of [...edges.keys()].sort((left, right) => left.localeCompare(right))) {
    if (order.has(root)) continue;
    const work: { readonly node: string; next: number }[] = [{ node: root, next: 0 }];
    order.set(root, counter); low.set(root, counter); counter += 1;
    stack.push(root); onStack.add(root);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      const neighbours = edges.get(frame.node) ?? [];
      const edge = neighbours[frame.next];
      if (edge !== undefined) {
        frame.next += 1;
        if (!edges.has(edge.to)) continue;
        if (!order.has(edge.to)) {
          order.set(edge.to, counter); low.set(edge.to, counter); counter += 1;
          stack.push(edge.to); onStack.add(edge.to);
          work.push({ node: edge.to, next: 0 });
        } else if (onStack.has(edge.to)) {
          low.set(frame.node, Math.min(low.get(frame.node) ?? 0, order.get(edge.to) ?? 0));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) low.set(parent.node, Math.min(low.get(parent.node) ?? 0, low.get(frame.node) ?? 0));
      if (low.get(frame.node) !== order.get(frame.node)) continue;
      const component: string[] = [];
      for (;;) {
        const member = stack.pop();
        if (member === undefined) break;
        onStack.delete(member);
        component.push(member);
        if (member === frame.node) break;
      }
      components.push(component.sort((left, right) => left.localeCompare(right)));
    }
  }
  return components;
}

export const importCycleRule: AnalysisRule = {
  id: "import-cycle",
  category: "structure",
  languages: JS_FAMILY,
  scopes: ["repository"],
  limitation: "A cycle is a structural observation. Whether it causes an initialization-order defect depends on what each module does at load time, which is not analyzed. Type-only imports are ignored; dynamic imports and re-export chains are not followed.",
  run(context) {
    const edges = runtimeImports(context);
    const matches: RuleMatch[] = [];
    const components = stronglyConnected(edges)
      .filter((component) => component.length > 1 || (edges.get(component[0] ?? "") ?? []).some((edge) => edge.to === component[0]))
      .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""));
    for (const component of components) {
      const members = new Set(component);
      const evidence = component.flatMap((path) =>
        (edges.get(path) ?? []).filter((edge) => members.has(edge.to)).map((edge) => ({
          path,
          startLine: edge.line,
          endLine: edge.line,
          reason: `Imports ${edge.to}, which is part of the same cycle`,
        })));
      const shown = component.slice(0, 8).join(", ") + (component.length > 8 ? `, and ${String(component.length - 8)} more` : "");
      matches.push({
        ruleId: "import-cycle",
        title: `Import cycle between ${String(component.length)} ${component.length === 1 ? "file" : "files"}`,
        detail: `These files import each other at load time, directly or through one another: ${shown}.`,
        remediation: "Check whether any of these modules reads another's exports while loading. If so, move the shared part into a module that none of them imports back.",
        evidence: evidence.slice(0, MAX_CYCLE_EVIDENCE),
        sequence: 0,
      });
    }
    return { matches, filesExamined: [...edges.keys()] };
  },
};

/** Rules whose meaning holds for the lines of a change. */
export const CHANGE_RULES: readonly AnalysisRule[] = [parserDiagnosticRule, unreleasedResourceRule, inconsistentKeyRule, discardedErrorRule];

/** Rules whose meaning holds for a whole repository snapshot. */
export const REPOSITORY_RULES: readonly AnalysisRule[] = [
  parserDiagnosticRule,
  discardedErrorRule,
  unreleasedResourceRule,
  inconsistentKeyRule,
  unresolvedImportRule,
  importCycleRule,
];
