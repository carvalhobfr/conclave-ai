import { describe, expect, it } from "vitest";

import type { RepositoryCodeIndex } from "../src/domain/code-index.js";
import type { ValidationChangedFile, ValidationFinding } from "../src/domain/validation.js";
import { applyInlineSuppressions } from "../src/validation/finding-suppression.js";
import { findSourceDefects } from "../src/validation/source-defects.js";

function index(files: Readonly<Record<string, string>>): RepositoryCodeIndex {
  return {
    files: Object.fromEntries(Object.entries(files).map(([path, sourceText]) => [path, { path, sourceText }])),
  } as unknown as RepositoryCodeIndex;
}

function whole(path: string): ValidationChangedFile {
  return { path, status: "added", hunks: [] };
}

function defects(path: string, source: string): readonly { kind: string; line: number | undefined }[] {
  return findSourceDefects(index({ [path]: source }), [whole(path)]).map((defect) => ({ kind: defect.kind, line: defect.evidence.startLine }));
}

describe("Python source defects", () => {
  it("reports an except block that only passes", () => {
    expect(defects("app.py", "def f():\n    try:\n        g()\n    except Exception:\n        pass\n")).toEqual([{ kind: "discarded-error", line: 4 }]);
    expect(defects("app.py", "try:\n    g()\nexcept ValueError: pass\n")).toEqual([{ kind: "discarded-error", line: 3 }]);
  });

  it("accepts an except block that handles the error", () => {
    expect(defects("app.py", "try:\n    g()\nexcept Exception as error:\n    log(error)\n")).toEqual([]);
    expect(defects("app.py", "try:\n    g()\nexcept Exception:\n    pass\n    log()\n")).toEqual([]);
  });

  it("reports an opened file with no close and accepts with blocks or close", () => {
    expect(defects("io.py", "def read(path):\n    handle = open(path)\n    return handle.read()\n")).toEqual([{ kind: "unreleased-resource", line: 2 }]);
    expect(defects("io.py", "def read(path):\n    with open(path) as handle:\n        return handle.read()\n")).toEqual([]);
    expect(defects("io.py", "def read(path):\n    handle = open(path)\n    data = handle.read()\n    handle.close()\n    return data\n")).toEqual([]);
  });
});

describe("Java source defects", () => {
  it("reports an empty catch, including one holding only a comment", () => {
    expect(defects("A.java", "class A {\n  void f() {\n    try { g(); } catch (Exception e) {}\n  }\n}\n")).toEqual([{ kind: "discarded-error", line: 3 }]);
    expect(defects("A.java", "class A {\n  void f() {\n    try {\n      g();\n    } catch (IOException e) {\n      // ignored\n    }\n  }\n}\n")).toEqual([{ kind: "discarded-error", line: 5 }]);
    expect(defects("A.java", "class A {\n  void f() {\n    try { g(); } catch (Exception e) { log(e); }\n  }\n}\n")).toEqual([]);
  });

  it("reports a stream outside try-with-resources and accepts close or try-with-resources", () => {
    expect(defects("B.java", "class B {\n  void f() throws Exception {\n    FileInputStream in = new FileInputStream(\"x\");\n    in.read();\n  }\n}\n")).toEqual([{ kind: "unreleased-resource", line: 3 }]);
    expect(defects("B.java", "class B {\n  void f() throws Exception {\n    try (FileInputStream in = new FileInputStream(\"x\")) {\n      in.read();\n    }\n  }\n}\n")).toEqual([]);
    expect(defects("B.java", "class B {\n  void f() throws Exception {\n    FileInputStream in = new FileInputStream(\"x\");\n    in.read();\n    in.close();\n  }\n}\n")).toEqual([]);
  });

  it("only reports changed lines", () => {
    const source = "class A {\n  void f() {\n    try { g(); } catch (Exception e) {}\n  }\n  void h() {}\n}\n";
    const changed: ValidationChangedFile = { path: "A.java", status: "modified", hunks: [{ oldStart: 5, oldCount: 1, newStart: 5, newCount: 1 }] };
    expect(findSourceDefects(index({ "A.java": source }), [changed])).toEqual([]);
  });
});

describe("inline suppressions", () => {
  const warning = (path: string, line: number, kind = "discarded-error"): ValidationFinding => ({
    id: "f", fingerprint: "p", kind: kind as ValidationFinding["kind"], severity: "warning", title: "t", detail: "d.", remediation: "r",
    evidence: [{ path, startLine: line, endLine: line, reason: "x" }],
  });

  it("turns a directive on the same line or the line above into an auditable note", () => {
    const files = index({ "a.ts": "try { g(); } catch {} // conclave-ignore: discarded-error\n// conclave-ignore\nconst x = 1;\n" });
    const [sameLine, lineAbove] = applyInlineSuppressions(files, [warning("a.ts", 1), warning("a.ts", 3)]);
    expect(sameLine?.severity).toBe("info");
    expect(sameLine?.detail).toContain("Suppressed by a conclave-ignore directive at a.ts:1");
    expect(lineAbove?.severity).toBe("info");
  });

  it("respects the listed kinds and never silences blocking findings", () => {
    const files = index({ "a.py": "except Exception: pass  # conclave-ignore unreleased-resource\n" });
    expect(applyInlineSuppressions(files, [warning("a.py", 1)])[0]?.severity).toBe("warning");
    const blocking = { ...warning("a.py", 1, "unreleased-resource"), severity: "blocking" as const };
    expect(applyInlineSuppressions(files, [blocking])[0]?.severity).toBe("blocking");
  });
});
