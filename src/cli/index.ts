#!/usr/bin/env node

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { homedir } from "node:os";
import { join } from "node:path";

import { createDispatchCliHandlers } from "./dispatch/index.js";
import { createWakeupHealthHandler } from "./health/index.js";
import { createLocalWebhookIngestHandler } from "./ingest/index.js";
import { createProjectCliHandlers } from "./project/index.js";
import { defaultCliHandlers, runCli, type PackageMetadata } from "./program.js";
import { buildManualReconcileUseCase } from "./reconcile/composition.js";
import { createManualReconcileHandler } from "./reconcile/index.js";
import { createRegistrationCliHandlers } from "./registration/index.js";
import { createSystemdHandler } from "./systemd/index.js";

const require = createRequire(import.meta.url);
const metadata = require("../../package.json") as PackageMetadata;

const agentTeamHome = process.env["AGENT_TEAM_HOME"] ?? join(homedir(), ".agent-team");

process.exitCode = await runCli(metadata, process.argv.slice(2), {
  ...defaultCliHandlers,
  ...createDispatchCliHandlers({ agentTeamHome }),
  ...createProjectCliHandlers({ agentTeamHome }),
  health: createWakeupHealthHandler(),
  ingest: createLocalWebhookIngestHandler({
    ...(process.env["AGENT_TEAM_HOME"] === undefined ? {} : { agentTeamHome }),
  }),
  // E010b: real production composition (src/cli/reconcile/composition.ts) -- see that file's own
  // header for exactly which of `ReconcilePorts`' six ports are genuinely real today (leases reap
  // and job updates) versus disclosed, honest-fail-closed gaps (providers/events/processes/blocks,
  // structurally unreachable while `jobs.listActive` always returns `[]`).
  reconcile: createManualReconcileHandler({
    reconcile: buildManualReconcileUseCase({ agentTeamHome }),
  }),
  systemd: createSystemdHandler(fileURLToPath(import.meta.url)),
  registration: createRegistrationCliHandlers({ agentTeamHome }),
});
