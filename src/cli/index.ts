#!/usr/bin/env node

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { createWakeupHealthHandler } from "./health/index.js";
import { createLocalWebhookIngestHandler } from "./ingest/index.js";
import { defaultCliHandlers, runCli, type PackageMetadata } from "./program.js";
import { createUnwiredManualReconcileHandler } from "./reconcile/index.js";
import { createSystemdHandler } from "./systemd/index.js";

const require = createRequire(import.meta.url);
const metadata = require("../../package.json") as PackageMetadata;

process.exitCode = await runCli(metadata, process.argv.slice(2), {
  ...defaultCliHandlers,
  health: createWakeupHealthHandler(),
  ingest: createLocalWebhookIngestHandler({
    ...(process.env["AGENT_TEAM_HOME"] === undefined
      ? {}
      : { agentTeamHome: process.env["AGENT_TEAM_HOME"] }),
  }),
  reconcile: createUnwiredManualReconcileHandler(),
  systemd: createSystemdHandler(fileURLToPath(import.meta.url)),
});
