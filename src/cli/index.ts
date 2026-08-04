#!/usr/bin/env node

import { createRequire } from "node:module";

import { Command } from "commander";

interface PackageMetadata {
  readonly description: string;
  readonly version: string;
}

const require = createRequire(import.meta.url);
const metadata = require("../../package.json") as PackageMetadata;

const program = new Command()
  .name("agent-team")
  .description(metadata.description)
  .version(metadata.version)
  .showHelpAfterError();

if (process.argv.length <= 2) {
  program.outputHelp();
} else {
  program.parse();
}
