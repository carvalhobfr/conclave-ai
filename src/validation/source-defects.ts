import ts from "typescript";

import type { RepositoryCodeIndex } from "../domain/code-index.js";
import type { ValidationChangedFile, ValidationEvidence } from "../domain/validation.js";

export interface SourceDefect {
  readonly kind: "unreleased-resource" | "discarded-error" | "inconsistent-key";
  readonly title: string;
  readonly detail: string;
  readonly remediation: string;
  readonly evidence: ValidationEvidence;
}

const JS_FAMILY = /\.(?:[cm]?[jt]sx?)$/iu;

function intersects(node: ts.Node, source: ts.SourceFile, file: ValidationChangedFile, includeDeletions = false): boolean {
  if (file.status === "added") return true;
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return file.hunks.some((hunk) => (hunk.newCount > 0 || includeDeletions) && start < hunk.newStart + Math.max(1, hunk.newCount) && end >= hunk.newStart);
}

function method(call: ts.CallExpression): string {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text
    : ts.isIdentifier(call.expression) ? call.expression.text : "";
}

function receiver(call: ts.CallExpression, source: ts.SourceFile): string {
  return ts.isPropertyAccessExpression(call.expression) ? call.expression.expression.getText(source) : "";
}

function identity(node: ts.Node | undefined, source: ts.SourceFile): string | undefined {
  if (node === undefined) return undefined;
  if (ts.isStringLiteralLike(node)) return JSON.stringify(node.text);
  // Inline callbacks create different function objects even when their source text matches.
  if (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node)) return node.getText(source);
  return undefined;
}

function binding(call: ts.CallExpression, source: ts.SourceFile): string | undefined {
  const parent = call.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === call) {
    return identity(parent.left, source);
  }
  return undefined;
}

function capture(call: ts.CallExpression): string {
  const options = call.arguments[2];
  if (options === undefined || options.kind === ts.SyntaxKind.FalseKeyword) return "false";
  if (options.kind === ts.SyntaxKind.TrueKeyword) return "true";
  if (ts.isObjectLiteralExpression(options)) {
    const property = options.properties.find((item) => ts.isPropertyAssignment(item) && item.name.getText() === "capture");
    if (property === undefined) return "false";
    if (ts.isPropertyAssignment(property)) {
      if (property.initializer.kind === ts.SyntaxKind.TrueKeyword) return "true";
      if (property.initializer.kind === ts.SyntaxKind.FalseKeyword) return "false";
    }
  }
  return "unknown";
}

function once(call: ts.CallExpression): boolean {
  const options = call.arguments[2];
  return options !== undefined && ts.isObjectLiteralExpression(options) && options.properties.some((property) =>
    ts.isPropertyAssignment(property) && property.name.getText() === "once" && property.initializer.kind === ts.SyntaxKind.TrueKeyword);
}

function hasCleanup(call: ts.CallExpression, calls: readonly ts.CallExpression[], source: ts.SourceFile): boolean {
  const name = method(call);
  if (name === "addEventListener") {
    if (once(call)) return true;
    const event = identity(call.arguments[0], source);
    const handler = identity(call.arguments[1], source);
    return event !== undefined && handler !== undefined && capture(call) !== "unknown" && calls.some((other) =>
      method(other) === "removeEventListener" && receiver(other, source) === receiver(call, source) &&
      identity(other.arguments[0], source) === event && identity(other.arguments[1], source) === handler &&
      capture(other) === capture(call));
  }
  const target = binding(call, source);
  if (target === undefined) return false;
  if (name === "setInterval") return calls.some((other) => method(other) === "clearInterval" && identity(other.arguments[0], source) === target);
  return calls.some((other) => method(other) === "unsubscribe" && receiver(other, source) === target);
}

function defect(file: ValidationChangedFile, source: ts.SourceFile, node: ts.Node, details: Omit<SourceDefect, "evidence">): SourceDefect {
  const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  return { ...details, evidence: { path: file.path, startLine: line, endLine: line, reason: details.title } };
}

function storageIdentity(call: ts.CallExpression, source: ts.SourceFile): string | undefined {
  const name = receiver(call, source);
  return /^(?:(?:window|globalThis)\.)?(?:localStorage|sessionStorage)$/u.test(name)
    ? name.replace(/^(?:window|globalThis)\./u, "") : undefined;
}

/** Syntax-only observations. Absence of a finding never proves runtime correctness. */
export function analyzeSourceDefects(index: RepositoryCodeIndex, files: readonly ValidationChangedFile[]): { readonly defects: readonly SourceDefect[]; readonly checksPerformed: number } {
  const defects: SourceDefect[] = [];
  let checksPerformed = 0;
  for (const file of files) {
    if (file.status === "deleted" || !JS_FAMILY.test(file.path)) continue;
    const indexed = index.files[file.path];
    if (indexed === undefined) continue;
    if (file.status !== "added" && file.hunks.length === 0) continue;
    checksPerformed += 3; // resource candidates, storage keys, and empty catches for this file.
    const source = ts.createSourceFile(file.path, indexed.sourceText, ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    const catches: ts.CatchClause[] = [];
    const constants = new Map<string, string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) calls.push(node);
      if (ts.isCatchClause(node)) catches.push(node);
      // Only top-level literal constants are resolved; scoped aliases require semantic analysis.
      if (ts.isVariableStatement(node) && node.parent === source && (node.declarationList.flags & ts.NodeFlags.Const) !== 0) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name) && declaration.initializer !== undefined && ts.isStringLiteralLike(declaration.initializer)) {
            constants.set(declaration.name.text, declaration.initializer.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const call of calls.filter((node) => intersects(node, source, file))) {
      const name = method(call);
      if (["addEventListener", "setInterval", "subscribe"].includes(name) && !hasCleanup(call, calls, source)) {
        defects.push(defect(file, source, call, {
          kind: "unreleased-resource",
          title: "Changed resource has no matching cleanup candidate in this file",
          detail: `${name} has no syntactically matching cleanup candidate in this file. Cleanup may be delegated or the registration may be intentionally permanent; runtime lifetime is not proven by this check.`,
          remediation: "Check the resource lifetime and its matching teardown path. Add cleanup if required, or document the delegated or permanent lifetime.",
        }));
      }
      const store = storageIdentity(call, source);
      const key = call.arguments[0];
      if (store === undefined || !["setItem", "getItem", "removeItem"].includes(name) || key === undefined || !ts.isStringLiteralLike(key)) continue;
      const named = calls.filter((other) => storageIdentity(other, source) === store && ["setItem", "getItem", "removeItem"].includes(method(other)))
        .map((other) => other.arguments[0]).filter((argument): argument is ts.Identifier => argument !== undefined && ts.isIdentifier(argument))
        .map((argument) => argument.text).filter((identifier) => constants.has(identifier));
      if (named.length === 0 || named.some((identifier) => constants.get(identifier) === key.text)) continue;
      defects.push(defect(file, source, call, {
        kind: "inconsistent-key",
        title: "Changed storage call uses a different key from named keys in this file",
        detail: `${store} uses ${JSON.stringify(key.text)} here and also uses ${[...new Set(named)].join(", ")}. These may intentionally be separate entries; this is a key-consistency review signal.`,
        remediation: "Confirm the intended storage entry. Reuse its named key when these paths should address the same value.",
      }));
    }
    for (const clause of catches) {
      if (clause.block.statements.length > 0 || !intersects(clause, source, file, true)) continue;
      defects.push(defect(file, source, clause, {
        kind: "discarded-error",
        title: "Changed code has an empty catch block",
        detail: "This catch block contains no statements. The syntax shows that the error is ignored here; whether that is intentional requires review.",
        remediation: "Handle, rethrow or record the error, or document why ignoring this failure is correct.",
      }));
    }
  }
  return { defects, checksPerformed };
}

export function findSourceDefects(index: RepositoryCodeIndex, files: readonly ValidationChangedFile[]): readonly SourceDefect[] {
  return analyzeSourceDefects(index, files).defects;
}
