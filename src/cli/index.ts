#!/usr/bin/env node

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { homedir } from "node:os";
import { join } from "node:path";

import { createWakeupHealthHandler } from "./health/index.js";
import { createLocalWebhookIngestHandler } from "./ingest/index.js";
import { defaultCliHandlers, runCli, type PackageMetadata } from "./program.js";
import { createUnwiredManualReconcileHandler } from "./reconcile/index.js";
import { createRegistrationCliHandlers } from "./registration/index.js";
import { createSystemdHandler } from "./systemd/index.js";

const require = createRequire(import.meta.url);
const metadata = require("../../package.json") as PackageMetadata;

const agentTeamHome = process.env["AGENT_TEAM_HOME"] ?? join(homedir(), ".agent-team");

process.exitCode = await runCli(metadata, process.argv.slice(2), {
  ...defaultCliHandlers,
  health: createWakeupHealthHandler(),
  ingest: createLocalWebhookIngestHandler({
    ...(process.env["AGENT_TEAM_HOME"] === undefined ? {} : { agentTeamHome }),
  }),
  reconcile: createUnwiredManualReconcileHandler(),
  systemd: createSystemdHandler(fileURLToPath(import.meta.url)),
  registration: createRegistrationCliHandlers({ agentTeamHome }),
});
