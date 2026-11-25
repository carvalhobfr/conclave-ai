#!/usr/bin/env node

import { chmod, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tsc writes dist/cli.js without the executable bit; a linked checkout would stop running `conclave-crew`.
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(packageRoot, "dist", "cli.js");

if (process.platform !== "win32") {
  await chmod(cli, (await stat(cli)).mode | 0o111);
}
