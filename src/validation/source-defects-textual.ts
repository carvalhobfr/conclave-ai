import type { ValidationChangedFile } from "../domain/validation.js";
import type { SourceDefect } from "./source-defects.js";

// Python and Java get the same two review signals as TypeScript (swallowed errors and resources
// without a release) from line-level syntax. Like the TypeScript rules, these are review prompts:
// a finding does not prove a runtime leak and silence does not prove correct lifetime handling.

const DISCARDED_ERROR = {
  kind: "discarded-error",
  title: "Changed code has an empty catch block",
  remediation: "Handle, rethrow or record the error, or document why ignoring this failure is correct.",
} as const;

const UNRELEASED = {
  kind: "unreleased-resource",
  title: "Changed resource has no matching cleanup candidate in this file",
  remediation: "Check the resource lifetime and its matching teardown path. Add cleanup if required, or document the delegated or permanent lifetime.",
} as const;

function touches(file: ValidationChangedFile, start: number, end: number, includeDeletions = false): boolean {
  if (file.status === "added") return true;
  return file.hunks.some((hunk) =>
    (hunk.newCount > 0 || includeDeletions) && start < hunk.newStart + Math.max(1, hunk.newCount) && end >= hunk.newStart);
}

function make(file: ValidationChangedFile, line: number, base: typeof DISCARDED_ERROR | typeof UNRELEASED, detail: string): SourceDefect {
  return { ...base, detail, evidence: { path: file.path, startLine: line, endLine: line, reason: base.title } };
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

const PYTHON_RESOURCES = /^\s*([A-Za-z_][\w.]*)\s*=\s*((?:[\w.]+\.)?(?:open|connect|socket|Session|urlopen|TemporaryFile|NamedTemporaryFile|Popen))\s*\(/u;

function analyzePython(file: ValidationChangedFile, text: string): SourceDefect[] {
  const defects: SourceDefect[] = [];
  const lines = text.split(/\r?\n/u);
  const meaningful = (line: string | undefined): boolean => line !== undefined && line.trim() !== "" && !line.trim().startsWith("#");
  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    const handler = /^(\s*)except\b[^:]*:\s*(.*)$/u.exec(line);
    if (handler !== null) {
      const inline = (handler[2] ?? "").replace(/#.*$/u, "").trim();
      let body: string[];
      let end = number;
      if (inline !== "") {
        body = [inline];
      } else {
        const own = indentOf(line);
        body = [];
        for (let next = index + 1; next < lines.length; next += 1) {
          const candidate = lines[next] ?? "";
          if (!meaningful(candidate)) continue;
          if (indentOf(candidate) <= own) break;
          body.push(candidate.trim());
          end = next + 1;
        }
      }
      if (body.length > 0 && body.every((statement) => statement === "pass" || statement === "...") && touches(file, number, end, true)) {
        defects.push(make(file, number, DISCARDED_ERROR, "This except block only contains pass. The syntax shows that the error is ignored here; whether that is intentional requires review."));
      }
    }
    const resource = PYTHON_RESOURCES.exec(line);
    if (resource !== null && touches(file, number, number)) {
      const name = resource[1] ?? "";
      const released = new RegExp(`\\b${escapeRegExp(name)}\\s*\\.\\s*(?:close|shutdown|terminate|kill|__exit__)\\s*\\(|with\\s+(?:contextlib\\.)?closing\\(\\s*${escapeRegExp(name)}\\s*\\)|with\\s+${escapeRegExp(name)}\\b`, "u").test(text);
      if (!released) {
        defects.push(make(file, number, UNRELEASED, `${resource[2] ?? "resource"}() is assigned to ${name} outside a with block, and this file has no matching close. Ownership may be transferred elsewhere; runtime lifetime is not proven by this check.`));
      }
    }
  }
  return defects;
}

const JAVA_RESOURCE = /\b([A-Za-z_]\w*)\s*=\s*(?:new\s+(FileInputStream|FileOutputStream|FileReader|FileWriter|BufferedReader|BufferedWriter|InputStreamReader|OutputStreamWriter|PrintWriter|Scanner|Socket|ServerSocket|RandomAccessFile|ZipFile|JarFile)\b|(DriverManager\.getConnection|Files\.newBufferedReader|Files\.newBufferedWriter|Files\.newInputStream|Files\.newOutputStream|Executors\.new\w+))\s*\(/u;

function lineAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (text.charCodeAt(index) === 10) line += 1;
  return line;
}

function analyzeJava(file: ValidationChangedFile, text: string): SourceDefect[] {
  const defects: SourceDefect[] = [];
  const emptyCatch = /\bcatch\s*\([^)]*\)\s*\{(?:\s|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*\}/gu;
  for (const match of text.matchAll(emptyCatch)) {
    const start = lineAt(text, match.index);
    const end = lineAt(text, match.index + match[0].length);
    if (touches(file, start, end, true)) {
      defects.push(make(file, start, DISCARDED_ERROR, "This catch block contains no statements. The syntax shows that the exception is ignored here; whether that is intentional requires review."));
    }
  }
  for (const [index, line] of text.split(/\r?\n/u).entries()) {
    const number = index + 1;
    const resource = JAVA_RESOURCE.exec(line);
    if (resource === null || /\btry\s*\(/u.test(line) || !touches(file, number, number)) continue;
    const name = resource[1] ?? "";
    const kind = resource[2] ?? resource[3] ?? "resource";
    const released = new RegExp(`\\b${escapeRegExp(name)}\\s*\\.\\s*(?:close|shutdown|shutdownNow)\\s*\\(|try\\s*\\([^)]*\\b${escapeRegExp(name)}\\b`, "u").test(text);
    if (!released) {
      defects.push(make(file, number, UNRELEASED, `${kind} is assigned to ${name} outside try-with-resources, and this file has no matching close. Ownership may be transferred elsewhere; runtime lifetime is not proven by this check.`));
    }
  }
  return defects;
}

/** Returns undefined for languages without textual rules so the caller can skip counting checks. */
export function analyzeTextualSourceDefects(file: ValidationChangedFile, text: string): readonly SourceDefect[] | undefined {
  if (/\.py$/iu.test(file.path)) return analyzePython(file, text);
  if (/\.java$/iu.test(file.path)) return analyzeJava(file, text);
  return undefined;
}
