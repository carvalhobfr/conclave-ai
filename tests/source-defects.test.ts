import { describe, expect, it } from "vitest";

import type { RepositoryCodeIndex } from "../src/domain/code-index.js";
import type { ValidationChangedFile } from "../src/domain/validation.js";
import { analyzeSourceDefects, findSourceDefects } from "../src/validation/source-defects.js";

function index(files: Readonly<Record<string, string>>): RepositoryCodeIndex {
  return {
    files: Object.fromEntries(
      Object.entries(files).map(([path, sourceText]) => [path, { path, sourceText }]),
    ),
  } as unknown as RepositoryCodeIndex;
}

/** Marks the whole file as changed, which is what an added file reports. */
function whole(path: string): ValidationChangedFile {
  return { path, status: "added", hunks: [] };
}

function kinds(files: Readonly<Record<string, string>>, changed: readonly ValidationChangedFile[]): readonly string[] {
  return findSourceDefects(index(files), changed).map((defect) => defect.kind);
}

describe("deterministic source defects", () => {
  it("reports a listener the project never removes", () => {
    const source = 'export function init() {\n  window.addEventListener("storage", handler);\n}\n';
    expect(kinds({ "src/a.ts": source }, [whole("src/a.ts")])).toEqual(["unreleased-resource"]);
  });

  it("does not treat cleanup in another file as a verified match", () => {
    const files = {
      "src/a.ts": 'export function init() {\n  window.addEventListener("storage", handler);\n}\n',
      "src/teardown.ts": 'export function stop() {\n  window.removeEventListener("storage", handler);\n}\n',
    };
    expect(kinds(files, [whole("src/a.ts")])).toEqual(["unreleased-resource"]);
  });

  it("reports an empty catch block and accepts one with a body", () => {
    const empty = "export function f() {\n  try {\n    g();\n  } catch {\n  }\n}\n";
    expect(kinds({ "src/a.ts": empty }, [whole("src/a.ts")])).toEqual(["discarded-error"]);

    const handled = "export function f() {\n  try {\n    g();\n  } catch {\n    report();\n  }\n}\n";
    expect(kinds({ "src/a.ts": handled }, [whole("src/a.ts")])).toEqual([]);

    const sameLine = "export function f() {\n  try { g(); } catch (error) { report(error); }\n}\n";
    expect(kinds({ "src/a.ts": sameLine }, [whole("src/a.ts")])).toEqual([]);
  });

  it("reports a store keyed by a literal where the file keys it by a constant", () => {
    const source = [
      'const TOKEN_KEY = "auth-token";',
      "export function save(v: string) { localStorage.setItem(TOKEN_KEY, v); }",
      'export function clear() { localStorage.removeItem("token"); }',
      "",
    ].join("\n");
    expect(kinds({ "src/a.ts": source }, [whole("src/a.ts")])).toEqual(["inconsistent-key"]);
  });

  it("accepts a literal that spells out the constant's own value", () => {
    const source = [
      'const TOKEN_KEY = "auth-token";',
      "export function save(v: string) { localStorage.setItem(TOKEN_KEY, v); }",
      'export function clear() { localStorage.removeItem("auth-token"); }',
      "",
    ].join("\n");
    expect(kinds({ "src/a.ts": source }, [whole("src/a.ts")])).toEqual([]);
  });

  it("accepts a file that keys the store consistently", () => {
    const literals = 'export function save(v: string) { localStorage.setItem("a", v); }\nexport function clear() { localStorage.removeItem("a"); }\n';
    expect(kinds({ "src/a.ts": literals }, [whole("src/a.ts")])).toEqual([]);
  });

  it("ignores patterns that appear only inside strings or comments", () => {
    const source = [
      '// call addEventListener here later',
      'const note = "addEventListener";',
      'const other = "} catch { }";',
      "",
    ].join("\n");
    expect(kinds({ "src/a.ts": source }, [whole("src/a.ts")])).toEqual([]);
  });

  it("only inspects changed lines of a modified file", () => {
    const source = "export function f() {\n  try {\n    g();\n  } catch {\n  }\n}\n";
    const untouched: ValidationChangedFile = {
      path: "src/a.ts",
      status: "modified",
      hunks: [{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }],
    };
    expect(kinds({ "src/a.ts": source }, [untouched])).toEqual([]);

    const touched: ValidationChangedFile = {
      path: "src/a.ts",
      status: "modified",
      hunks: [{ oldStart: 4, oldCount: 1, newStart: 4, newCount: 1 }],
    };
    expect(kinds({ "src/a.ts": source }, [touched])).toEqual(["discarded-error"]);
  });

  it("skips deleted files and non-JavaScript-family paths", () => {
    const source = 'window.addEventListener("storage", handler);\n';
    expect(kinds({ "src/a.ts": source }, [{ path: "src/a.ts", status: "deleted", hunks: [] }])).toEqual([]);
    expect(kinds({ "src/a.py": source }, [whole("src/a.py")])).toEqual([]);
  });
});

describe("source rule precision regressions", () => {
  it.each([
    'window.removeEventListener("click", handler);',
    'document.removeEventListener("storage", handler);',
    'window.removeEventListener("storage", anotherHandler);',
    'window.removeEventListener("storage", handler, true);',
    '// window.removeEventListener("storage", handler);',
    'const note = `window.removeEventListener("storage", handler)`;',
  ])("does not let unrelated or non-code cleanup hide a listener: %s", (decoy) => {
    expect(kinds({ "src/a.ts": `window.addEventListener("storage", handler);\n${decoy}` }, [whole("src/a.ts")])).toContain("unreleased-resource");
  });
  it("recognizes multiline matching listener calls without claiming runtime execution", () => {
    const source = 'window.addEventListener(\n "storage",\n handler\n);\nwindow.removeEventListener("storage", handler);';
    expect(kinds({ "src/a.ts": source }, [whole("src/a.ts")])).toEqual([]);
  });
  it("does not conflate two identical inline function bodies", () => {
    const source = 'window.addEventListener("storage", () => run()); window.removeEventListener("storage", () => run());';
    expect(kinds({ "src/a.ts": source }, [whole("src/a.ts")])).toContain("unreleased-resource");
  });
  it("respects native once listeners", () => {
    expect(kinds({ "src/a.ts": 'window.addEventListener("storage", handler, {once: true});' }, [whole("src/a.ts")])).toEqual([]);
  });
  it("matches interval and subscription cleanup to the acquired value", () => {
    const correct = 'const timer = setInterval(tick, 1000); clearInterval(timer); const sub = events.subscribe(handle); sub.unsubscribe();';
    const wrong = 'const timer = setInterval(tick, 1000); clearInterval(other); const sub = events.subscribe(handle); otherSub.unsubscribe();';
    expect(kinds({ "src/a.ts": correct }, [whole("src/a.ts")])).toEqual([]);
    expect(kinds({ "src/a.ts": wrong }, [whole("src/a.ts")])).toEqual(["unreleased-resource", "unreleased-resource"]);
  });
  it("detects a catch whose body was emptied while the catch line stayed unchanged", () => {
    const source = 'try { run(); } catch {\n\n}';
    expect(kinds({ "src/a.ts": source }, [{ path: "src/a.ts", status: "modified", hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }] }])).toEqual(["discarded-error"]);
  });
  it("ignores source-like strings and multiline comments", () => {
    const source = '/*\nwindow.addEventListener("x", handler);\ntry {} catch {}\n*/\nconst note = `localStorage.getItem(KEY); localStorage.removeItem("wrong");`;';
    expect(kinds({ "src/a.ts": source }, [whole("src/a.ts")])).toEqual([]);
  });
  it("does not confuse localStorage with sessionStorage or an unrelated object", () => {
    const source = 'const KEY = "a"; localStorage.setItem(KEY, "v"); sessionStorage.getItem("b"); custom.getItem("c");';
    expect(kinds({ "src/a.ts": source }, [whole("src/a.ts")])).toEqual([]);
  });
});

describe("evaluated check count", () => {
  it("counts evaluated rule scopes even when they produce no finding", () => {
    const source = 'export function add(a: number, b: number) { return a + b; }';
    const result = analyzeSourceDefects(index({ "src/a.ts": source }), [whole("src/a.ts")]);
    expect(result.defects).toEqual([]);
    expect(result.checksPerformed).toBe(3);
  });
  it("reports a catch emptied by a deletion-only hunk", () => {
    const source = 'try { run(); } catch {\n}';
    expect(kinds({ "src/a.ts": source }, [{ path: "src/a.ts", status: "modified", hunks: [{ oldStart: 2, oldCount: 1, newStart: 1, newCount: 0 }] }])).toEqual(["discarded-error"]);
  });
});
