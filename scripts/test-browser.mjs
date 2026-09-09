import { spawn } from "node:child_process";
const child = spawn(process.execPath, ["node_modules/vitest/vitest.mjs", "run", "tests/browser-smoke.test.ts", "tests/cockpit-browser.test.ts", "--maxWorkers=1"], { stdio: "inherit", env: { ...process.env, CONCLAVE_BROWSER_TESTS: "1" } });
child.on("error", () => { process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
