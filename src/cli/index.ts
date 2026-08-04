#!/usr/bin/env node

import { createRequire } from "node:module";

import { createProgram, type PackageMetadata } from "./program.js";

const require = createRequire(import.meta.url);
const metadata = require("../../package.json") as PackageMetadata;

const program = createProgram(metadata);

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  program.parse();
}
