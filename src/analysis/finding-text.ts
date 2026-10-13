import { createHash } from "node:crypto";

import type { AuditFinding } from "../domain/audit.js";
import type { RepositoryCodeIndex } from "../domain/code-index.js";
import { redactSecrets } from "../security/model-context.js";

/** Repository-derived text as it may be stored and shown: no control characters, no recognized credential. */
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  const visible = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/gu, " ");
  // Rule text can quote the source (a storage key, a parser message). A report is saved, shown
  // and may be drafted into an issue, so a quoted value that looks like a credential is replaced
  // by its category; text that still matches a detector afterwards is withheld whole.
  const scan = redactSecrets(visible);
  return scan.residual ? "[withheld: matched a credential detector]" : scan.text;
}

/**
 * Digest of the source text a finding points at. Line numbers are left out, so code that only
 * moved keeps its digest; an edit to the flagged text changes it. Evidence without lines is
 * bound to the whole file's content hash.
 */
export function evidenceDigest(index: RepositoryCodeIndex, ruleId: string, evidence: AuditFinding["evidence"]): string {
  const hash = createHash("sha256").update(`${ruleId}\n`);
  for (const item of evidence) {
    const file = index.files[item.path];
    hash.update(`${item.path}\0`);
    if (file === undefined) hash.update("absent");
    else if (item.startLine === undefined) hash.update(`file\0${file.contentHash}`);
    else {
      const lines = file.sourceText.split(/\r?\n/u).slice(item.startLine - 1, item.endLine ?? item.startLine);
      hash.update(lines.map((line) => line.replace(/\s+/gu, " ").trim()).join("\n"));
    }
    hash.update("\n");
  }
  return "evidence_" + hash.digest("hex").slice(0, 32);
}
