import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { MultiLanguageCodeParser } from "../src/code-intelligence/multi-language-parser.js";
import type { ContextBundle } from "../src/domain/context-bundle.js";
import type { ReasoningChangeContext } from "../src/domain/reasoning.js";
import { DEFAULT_REASONING_LIMITS } from "../src/domain/reasoning.js";
import { LocalHashEmbeddingProvider } from "../src/embeddings/local-hash-embedding.js";
import { OpenAiCompatibleEmbeddingProvider } from "../src/embeddings/openai-compatible-embedding.js";
import { InMemoryCodeIndexStore } from "../src/indexing/in-memory-index-store.js";
import { RepositoryIndexer } from "../src/indexing/repository-indexer.js";
import { FakeProvider } from "../src/providers/fake-provider.js";
import { AgentExecutionError, StructuredAgentRuntime } from "../src/reasoning/agent-runtime.js";
import { inferReasoningChangeContext } from "../src/reasoning/change-context.js";
import { investigatorPrompt } from "../src/reasoning/role-prompts.js";
import { LocalFolderRepository } from "../src/repositories/local-folder-repository.js";
import { CodeRetrievalService } from "../src/retrieval/code-retrieval-service.js";
import { EXCLUDED_CONTEXT_MARKER, ModelContextLedger, protectOutgoingMessages, redactSecrets } from "../src/security/model-context.js";
import { createReasoningFixtureEngine, reasoningFixtureProvider } from "./helpers/reasoning-fixture.js";

const execute = promisify(execFile);

// Synthetic values, assembled at run time so this file does not itself match a detector.
const API_KEY = ["sk", "synthetic0boundary0key0value00"].join("-");
const SLACK = ["xoxb", "1234567890", "syntheticboundarytoken"].join("-");
const JWT = ["eyJzeW50aGV0aWM", "eyJib3VuZGFyeSI6dHJ1ZX0", "c3ludGhldGljc2lnbmF0dXJl"].join(".");
const PASSWORD = ["synthetic", "boundary", "pass"].join("-");
const KEY_HEADER = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
const KEY_FOOTER = ["-----END", "RSA PRIVATE KEY-----"].join(" ");
const KEY_BODY = "c3ludGhldGljLXByaXZhdGUta2V5LWJvZHk";
const SECRETS = [API_KEY, SLACK, JWT, PASSWORD, KEY_BODY];

function expectClean(text: string): void {
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

describe("secret redaction", () => {
  it("replaces recognized secrets and keeps the surrounding code", () => {
    const source = [
      "export function connect() {",
      `  const client = create({ token: "${SLACK}" });`,
      `  const ${["pass", "word"].join("")} = "${PASSWORD}";`,
      `  headers.set("authorization", "Bearer ${JWT}");`,
      `  const url = "postgres://app:${PASSWORD}@db.internal/app";`,
      "  return client.open(url);",
      "}",
    ].join("\n");
    const result = redactSecrets(source);

    expectClean(result.text);
    expect(result.residual).toBe(false);
    expect(result.redactions["credential"]).toBeGreaterThanOrEqual(4);
    expect(result.text).toContain("export function connect() {");
    expect(result.text).toContain("return client.open(url);");
    expect(result.text).toContain("postgres://app:[REDACTED:credential]@db.internal/app");
  });

  it("redacts a complete private key block and refuses an unterminated one", () => {
    const complete = redactSecrets(`const pem = \`${KEY_HEADER}\n${KEY_BODY}\n${KEY_FOOTER}\`;\nexport const ready = true;`);
    expect(complete.text).toBe("const pem = `[REDACTED:private-key]`;\nexport const ready = true;");
    expect(complete.residual).toBe(false);

    const cut = redactSecrets(`${KEY_HEADER}\n${KEY_BODY}`);
    expect(cut.residual).toBe(true);
  });

  it("finds a quoted assignment inside serialized JSON", () => {
    const serialized = JSON.stringify({ excerpt: `const ${["api", "Key"].join("")} = "${PASSWORD}";\nconst kept = 1;` });
    const result = redactSecrets(serialized);

    expectClean(result.text);
    expect(JSON.parse(result.text)).toEqual({ excerpt: expect.stringContaining("const kept = 1;") as unknown });
  });

  it("leaves ordinary source untouched", () => {
    const source = "export function sum(a: number, b: number) {\n  return a + b;\n}\nconst tokenKey = \"auth-token\";\n";
    expect(redactSecrets(source)).toEqual({ text: source, redactions: {}, residual: false });
  });
});

describe("diff hunks", () => {
  async function git(root: string, args: readonly string[]): Promise<void> {
    await execute("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root });
  }

  it("sanitizes credentials on added and removed lines before the hunk is kept", async () => {
    const root = await mkdtemp(join(tmpdir(), "conclave-context-hunks-"));
    try {
      await mkdir(join(root, "src"));
      // The removed line carries a key the working tree no longer has; the added line carries
      // a token format that file-level indexing does not block.
      await writeFile(join(root, "src", "client.ts"), `export function connect() {\n  return open("${API_KEY}");\n}\n`);
      await git(root, ["init", "-b", "main"]);
      await git(root, ["add", "."]);
      await git(root, ["commit", "-m", "baseline"]);
      await writeFile(join(root, "src", "client.ts"), `export function connect() {\n  const retries = 3;\n  return open("${SLACK}", retries);\n}\n`);
      const embedding = new LocalHashEmbeddingProvider();
      const { index } = await new RepositoryIndexer({
        repositorySource: new LocalFolderRepository(),
        parser: new MultiLanguageCodeParser(),
        embeddingProvider: embedding,
        indexStore: new InMemoryCodeIndexStore(),
      }).index(root);

      const context = await inferReasoningChangeContext(root, new CodeRetrievalService(index, embedding));
      const patch = context?.hunks[0]?.patch ?? "";

      expect(context?.paths).toEqual(["src/client.ts"]);
      expectClean(JSON.stringify(context));
      expect(patch).toContain("-  return open(\"[REDACTED:credential]\");");
      expect(patch).toContain("+  return open(\"[REDACTED:credential]\", retries);");
      expect(patch).toContain("+  const retries = 3;");
      expect(context?.protection).toEqual({ redactions: [{ source: "src/client.ts", kind: "credential", count: 2 }], exclusions: [] });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 30000);
});

function changeContext(patch: string): ReasoningChangeContext {
  return { source: "working", paths: ["src/auth/AuthProvider.ts"], symbols: ["bootstrapSession"], relatedSymbols: [], hunks: [{ path: "src/auth/AuthProvider.ts", patch }], reviewDimensions: [] };
}

describe("provider request payload", () => {
  it("never carries a secret from added or removed diff lines, and reports what was redacted", async () => {
    const provider = reasoningFixtureProvider();
    const patch = [
      "@@ -1,4 +1,5 @@",
      " export function bootstrapSession() {",
      `-  const legacy = "${API_KEY}";`,
      `+  const bearer = "Bearer ${JWT}";`,
      "+  const attempts = 2;",
      "   return restore();",
    ].join("\n");
    const engine = await createReasoningFixtureEngine(provider, 10, undefined, changeContext(patch));
    const result = await engine.ask("Review the current change.", "investigator-judge");

    expect(provider.requests.length).toBeGreaterThan(0);
    const sent = JSON.stringify(provider.requests);
    expectClean(sent);
    // The safe lines of the same hunk still reach the model.
    expect(sent).toContain("const attempts = 2;");
    expect(sent).toContain("[REDACTED:credential]");
    expectClean(JSON.stringify(result));
    expect(result.contextProtection?.redactions).toEqual([{ source: "src/auth/AuthProvider.ts", kind: "credential", count: 2 }]);
    expect(result.trace.find((event) => event.type === "context_protected")?.data).toEqual({ redactions: 2, excluded: 0 });
  });

  it("withholds a hunk that cannot be sanitized and still sends the rest", async () => {
    const provider = reasoningFixtureProvider();
    const engine = await createReasoningFixtureEngine(provider, 10, undefined, changeContext(`+const pem = \`${KEY_HEADER}\n+${KEY_BODY}`));
    const result = await engine.ask("Review the current change.", "single-pass");

    const sent = JSON.stringify(provider.requests);
    expectClean(sent);
    expect(sent).not.toContain("PRIVATE KEY");
    expect(sent).toContain(EXCLUDED_CONTEXT_MARKER);
    expect(sent).toContain("bootstrapSession");
    expect(result.contextProtection?.exclusions).toEqual([{ source: "src/auth/AuthProvider.ts", reason: "unsanitizable-secret" }]);
    expect(result.state.changeContext?.hunks[0]?.patch).toBe(EXCLUDED_CONTEXT_MARKER);
  });

  it("sanitizes retrieved file content, keeping the safe part of a mixed excerpt", () => {
    const ledger = new ModelContextLedger();
    const bundle = {
      evidence: [
        { id: "a", path: "src/keys.ts", startLine: 1, endLine: 2, excerpt: `export const key = "${API_KEY}";\nexport const region = "eu";`, rank: 1, symbols: [], sourceEvidenceIds: ["a"], sourceUnitIds: [], reasons: [], contentHash: "" },
        { id: "b", path: "src/pem.ts", startLine: 1, endLine: 2, excerpt: `${KEY_HEADER}\n${KEY_BODY}`, rank: 2, symbols: [], sourceEvidenceIds: ["b"], sourceUnitIds: [], reasons: [], contentHash: "" },
        { id: "c", path: "src/safe.ts", startLine: 1, endLine: 1, excerpt: "export const safe = true;", rank: 3, symbols: [], sourceEvidenceIds: ["c"], sourceUnitIds: [], reasons: [], contentHash: "" },
      ],
      relationships: [],
      stats: {},
      budget: {},
    } as unknown as ContextBundle;
    const prompt = investigatorPrompt("What does this do?", bundle, undefined, ledger);

    expectClean(prompt);
    expect(prompt).toContain("export const region = \\\"eu\\\";");
    expect(prompt).toContain("export const safe = true;");
    expect(prompt).toContain(EXCLUDED_CONTEXT_MARKER);
    expect(ledger.summary()).toEqual({
      redactions: [{ source: "src/keys.ts", kind: "credential", count: 1 }],
      exclusions: [{ source: "src/pem.ts", reason: "unsanitizable-secret" }],
    });
  });

  it("scans the assembled request at the runtime, whatever built the prompt", async () => {
    const provider = new FakeProvider((request) => ({ provider: "fake", model: request.model, text: "{}" }));
    const runtime = new StructuredAgentRuntime(new Map([["fake", provider]]), [{ role: "investigator", providerId: "fake", modelId: "m" }], DEFAULT_REASONING_LIMITS);
    const prompt = JSON.stringify({ question: `Why does ${API_KEY} fail?`, excerpt: `const ${["pass", "word"].join("")} = "${PASSWORD}";`, kept: "export const region = 1;" });

    const execution = await runtime.execute("investigator", prompt, (raw) => raw);

    const sent = JSON.stringify(provider.requests);
    expectClean(sent);
    expect(sent).toContain("export const region = 1;");
    expect(execution.calls[0]?.contextRedactions).toEqual({ credential: 2 });
  });

  it("fails closed: an unsanitizable request is never sent", async () => {
    const provider = new FakeProvider();
    const runtime = new StructuredAgentRuntime(new Map([["fake", provider]]), [{ role: "investigator", providerId: "fake", modelId: "m" }], DEFAULT_REASONING_LIMITS);

    const failure = await runtime.execute("investigator", `${KEY_HEADER}\n${KEY_BODY}`, (raw) => raw).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentExecutionError);
    expect((failure as Error).message).toContain("nothing was sent");
    expectClean((failure as Error).message);
    expect(provider.requests).toEqual([]);
    expect(() => protectOutgoingMessages([{ role: "user", content: KEY_HEADER }])).toThrow("nothing was sent");
  });

  it("applies the same boundary to remote embedding input", async () => {
    const bodies: string[] = [];
    const provider = new OpenAiCompatibleEmbeddingProvider({
      id: "openai-compatible:test",
      baseUrl: "https://embeddings.example.invalid/v1",
      model: "embed",
      dimensions: 2,
      apiKey: "unused",
      fetchImplementation: (_url, init) => {
        bodies.push(typeof init?.body === "string" ? init.body : "");
        return Promise.resolve(new Response(JSON.stringify({ data: [{ embedding: [0, 1] }, { embedding: [1, 0] }] }), { status: 200 }));
      },
    });

    await provider.embed([{ identity: "q", text: `find uses of ${API_KEY}` }, { identity: "k", text: `${KEY_HEADER}\n${KEY_BODY}` }]);

    expectClean(bodies.join(""));
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual({ model: "embed", input: ["find uses of [REDACTED:credential]", EXCLUDED_CONTEXT_MARKER] });
  });
});
