#!/usr/bin/env node

import { chmod, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// tsc writes dist/cli.js without the executable bit. npm sets it when it installs the package, but a
// linked checkout (`npm link`) loses it on every build and `conclave` stops running ("permission denied").
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(projectRoot, "dist", "cli.js");

if (process.platform !== "win32") {
  await chmod(cli, (await stat(cli)).mode | 0o111);
}
