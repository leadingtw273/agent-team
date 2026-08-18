import { randomUUID } from "node:crypto";
import { join } from "node:path";

import {
  FileIssueScopeLock,
  JobProgressWorkStatusLifecycleLedger,
} from "../../adapters/dispatch/index.js";
import { WorkStatusLifecycleCoordinator } from "../../application/pipelines/index.js";
import { LeaseCoordinator } from "../../application/leases/index.js";
import { createClock, type Clock } from "../../domain/foundation/index.js";
import { jobIdSchema } from "../../domain/jobs/index.js";
import type { CliCommandOutcome } from "../program.js";
import { buildDispatchComposition } from "./composition.js";
import { buildIssueAdmissionStore, buildJobProgressStore } from "./resume-composition.js";
import { LinearWorkManagementAdapter } from "./work-management-adapter.js";
import {
  WorkStatusRecoveryCoordinator,
  type WorkStatusRecoveryOutcome,
} from "./work-status-recovery-coordinator.js";

export interface WorkStatusRecoveryHandlerInput {
  readonly jobId: string;
  readonly transitionInstance: string;
  readonly dryRun?: boolean;
}

export interface CreateWorkStatusRecoveryHandlerOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly clock?: Clock;
  readonly generateHolderId?: () => string;
  readonly coordinatorFactory?: (
    jobId: string,
  ) => Promise<WorkStatusRecoveryCoordinator | CliCommandOutcome>;
}

function rendered(result: WorkStatusRecoveryOutcome): CliCommandOutcome {
  const state =
    result.state === "ready" || result.state === "recovered"
      ? "success"
      : result.state === "blocked"
        ? "blocked"
        : "failed";
  return Object.freeze({
    state,
    message: JSON.stringify({ operation: "work-status-recover", ...result }),
  });
}

export function createWorkStatusRecoveryHandler(options: CreateWorkStatusRecoveryHandlerOptions) {
  const clock = options.clock ?? createClock();
  const progress = buildJobProgressStore(options.agentTeamHome);
  const admission = buildIssueAdmissionStore(options.agentTeamHome);

  return async (input: WorkStatusRecoveryHandlerInput): Promise<CliCommandOutcome> => {
    if (
      !jobIdSchema.safeParse(input.jobId).success ||
      !/^[0-9a-f]{64}$/u.test(input.transitionInstance)
    ) {
      return Object.freeze({
        state: "rejected",
        message: JSON.stringify({
          operation: "work-status-recover",
          state: "rejected",
          reason: "invalid_command_input",
        }),
      });
    }
    let coordinator: WorkStatusRecoveryCoordinator | CliCommandOutcome;
    if (options.coordinatorFactory !== undefined) {
      coordinator = await options.coordinatorFactory(input.jobId);
    } else {
      const record = await progress.load(input.jobId);
      if (!record.ok || record.value === undefined) {
        return rendered({
          state: "blocked",
          reason: record.ok ? "job_not_found" : "job_identity_mismatch",
        });
      }
      const built = await buildDispatchComposition({
        agentTeamHome: options.agentTeamHome,
        projectId: record.value.projectId,
        ...(options.environment === undefined ? {} : { environment: options.environment }),
      });
      if (built.state !== "ready") {
        return Object.freeze({
          state: "blocked",
          message: JSON.stringify({
            operation: "work-status-recover",
            state: "blocked",
            reason: built.reason,
          }),
        });
      }
      const workManagement = new LinearWorkManagementAdapter({
        readModel: built.value.discovery.readModel,
        mutationClient: built.value.discovery.mutationClient,
        teamId: built.value.discovery.teamId,
        linearProjectId: built.value.discovery.linearProjectId,
      });
      const locks = new FileIssueScopeLock(
        join(options.agentTeamHome, "state", "dispatch", "issue-scope-locks"),
      );
      coordinator = new WorkStatusRecoveryCoordinator({
        progress,
        jobs: built.value.jobs,
        admission,
        leases: new LeaseCoordinator(built.value.leases, { clock }),
        locks,
        workManagement,
        lifecycle: new WorkStatusLifecycleCoordinator({
          workManagement,
          history: workManagement,
          ledger: new JobProgressWorkStatusLifecycleLedger(progress),
          locks,
          clock,
        }),
        project: built.value.project,
        clock,
      });
    }
    if (!(coordinator instanceof WorkStatusRecoveryCoordinator)) return coordinator;
    return rendered(
      await coordinator.run({
        jobId: input.jobId,
        transitionInstance: input.transitionInstance,
        dryRun: input.dryRun === true,
        holderId: options.generateHolderId?.() ?? `work-status-recover:${randomUUID()}`,
      }),
    );
  };
}
