#!/usr/bin/env node

import { createRequire } from "node:module";

import { createLocalWebhookIngestHandler } from "./ingest/index.js";
import { defaultCliHandlers, runCli, type PackageMetadata } from "./program.js";

const require = createRequire(import.meta.url);
const metadata = require("../../package.json") as PackageMetadata;

process.exitCode = await runCli(metadata, process.argv.slice(2), {
  ...defaultCliHandlers,
  ingest: createLocalWebhookIngestHandler({
    ...(process.env["AGENT_TEAM_HOME"] === undefined
      ? {}
      : { agentTeamHome: process.env["AGENT_TEAM_HOME"] }),
  }),
});
