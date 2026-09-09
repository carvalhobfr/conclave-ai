import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EvidenceReceiptInput } from "../domain/validation.js";
import { parseEvidenceReceiptEnvelope } from "./evidence-receipts.js";

const execute = promisify(execFile);
const verified = new WeakSet<EvidenceReceiptInput>();

/** JSON cannot grant provenance. Only receipts verified in this process receive this marker. */
export function hasVerifiedProvenance(receipt: EvidenceReceiptInput): boolean { return verified.has(receipt); }

export async function loadAttestedEvidence(path: string, repository: string, workflow: string): Promise<readonly EvidenceReceiptInput[]> {
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !workflow.startsWith(repository + "/.github/workflows/") || !/\.ya?ml$/u.test(workflow) || workflow.includes("..")) throw new Error("Specify the expected owner/repository and its exact signing workflow path");
  const bytes = await readFile(path);
  if (bytes.length > 1_000_000) throw new Error("Attested receipt file exceeds 1 MB");
  const receipts = parseEvidenceReceiptEnvelope(JSON.parse(bytes.toString("utf8")), path);
  const head = receipts[0]?.headSha;
  if (receipts.length === 0 || head === undefined || !/^[a-f0-9]{40,64}$/u.test(head) || receipts.some((item) => item.headSha !== head || (item.validationErrors?.length ?? 0) > 0)) throw new Error("Attested receipts must be valid and share one source commit");
  const directory = await mkdtemp(join(tmpdir(), "conclave-attestation-"));
  try {
    const snapshot = join(directory, "receipts.json");
    await writeFile(snapshot, bytes, { mode: 0o600, flag: "wx" });
    await execute("gh", ["attestation", "verify", snapshot, "--repo", repository, "--signer-workflow", workflow, "--source-digest", head, "--deny-self-hosted-runners", "--predicate-type", "https://slsa.dev/provenance/v1"], { timeout: 60_000, maxBuffer: 1_000_000, windowsHide: true });
    for (const receipt of receipts) { Object.freeze(receipt.criterionDigests); Object.freeze(receipt.artifactDigests); Object.freeze(receipt.validationErrors); Object.freeze(receipt); verified.add(receipt); }
    return receipts;
  } finally { await rm(directory, { recursive: true, force: true }); }
}
