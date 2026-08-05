#!/usr/bin/env node

import { createRequire } from "node:module";

import { runCli, type PackageMetadata } from "./program.js";

const require = createRequire(import.meta.url);
const metadata = require("../../package.json") as PackageMetadata;

process.exitCode = await runCli(metadata, process.argv.slice(2));
