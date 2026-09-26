import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Gives each test run its own temporary root and removes it afterwards. Suites create many
 * throwaway repositories; without this they accumulate in the system temp folder run after run.
 * Workers inherit the variables because they start after this setup.
 */
export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "conclave-test-run-"));
  for (const name of ["TMPDIR", "TMP", "TEMP"]) process.env[name] = root;
  return () => rmSync(root, { recursive: true, force: true });
}
