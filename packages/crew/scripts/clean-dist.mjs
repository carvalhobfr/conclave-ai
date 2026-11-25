#!/usr/bin/env node

import { rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = resolve(packageRoot, "dist");

if (dirname(outputDirectory) !== packageRoot) {
  throw new Error("Refusing to clean an unexpected build output directory");
}

await rm(outputDirectory, { recursive: true, force: true });
