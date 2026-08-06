/**
 * E005: wires `EvidenceCollectorPorts` (collector.ts) to the real, already-existing, read-only
 * production adapters -- this is the only file in the harness that touches Linear/GitHub/the
 * filesystem for real. Every call below is a GET/query; none of these adapters' write methods
 * are ever imported or referenced here (E006, a separate task, owns seed/reset -- the only
 * mutation this whole harness family is allowed).
 */
import { join } from "node:path";

import {
  GhTransport,
  GitHubAdapter,
  type GhJsonTransport,
} from "../../../src/adapters/github/index.js";
import { LinearGraphqlTransport, LinearReadModel } from "../../../src/adapters/linear/index.js";
import { parseIdentifier } from "../../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../../src/domain/project/index.js";
import { createAgentTeamUserLayout } from "../../../src/infrastructure/files/index.js";
import { DurableInbox, readEventLog } from "../../../src/infrastructure/events/index.js";
import type { EvidenceCaseDescription } from "./case.js";
import type { EvidenceCollectorPorts, EvidenceSourceRead } from "./collector.js";
import { readCheckpointsForIssue } from "./checkpoint-reader.js";
import type {
  CheckpointsEvidenceData,
  GithubEvidenceData,
  LinearEvidenceData,
  LocalEventsEvidenceData,
} from "./schema.js";

/**
 * `getChangeRequest`/`getCommitChecks`/`getCommitStatuses` (src/application/ports/source-
 * control.ts) all require a full `Project` domain object, but only ever read
 * `project.sourceControl.repository` -- every other field is structurally required by
 * `projectSchema` but functionally irrelevant to these three read calls. This fixed, valid,
 * never-persisted-or-compared placeholder exists purely so `projectSchema.parse` succeeds; its
 * id/displayName/etc. carry no meaning and are never read by anything this harness calls.
 */
function placeholderProjectFor(repository: string): Project {
  const projectId = parseIdentifier("project", "project_00000000-0000-4000-8000-000000000000");
  if (!projectId.ok) throw new Error("unreachable: fixed placeholder project id is well-formed");
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId.value,
    displayName: "E005 evidence collector placeholder",
    localRepositoryPath: "/tmp/e005-evidence-collector-unused",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "unused", projectId: "unused" },
    sourceControl: { provider: "github", repository },
  });
}

function readErrorResult<Data>(): EvidenceSourceRead<Data> {
  return { ok: false, reason: "read_error" };
}

function buildLinearPort(linearReadModel: LinearReadModel): EvidenceCollectorPorts["linear"] {
  return {
    async read(
      linear: EvidenceCaseDescription["linear"],
    ): Promise<EvidenceSourceRead<LinearEvidenceData>> {
      const context = await linearReadModel.readContext(linear.teamId, linear.projectId);
      if (!context.ok) return readErrorResult();
      const issue = await linearReadModel.readIssue(context.value, linear.issueId);
      if (!issue.ok) {
        return issue.error.code === "not_found"
          ? { ok: false, reason: "not_found" }
          : readErrorResult();
      }
      return {
        ok: true,
        data: {
          issueId: issue.value.id,
          identifier: issue.value.identifier,
          title: issue.value.title,
          workStatus: issue.value.workStatus,
          updatedAt: issue.value.updatedAt,
          comments: issue.value.comments.map((comment) => ({
            id: comment.id,
            body: comment.body,
            createdAt: comment.createdAt,
          })),
        },
      };
    },
  };
}

function buildGithubPort(github: GitHubAdapter): EvidenceCollectorPorts["github"] {
  return {
    async read(
      githubCase: EvidenceCaseDescription["github"],
    ): Promise<EvidenceSourceRead<GithubEvidenceData>> {
      const project = placeholderProjectFor(githubCase.repository);
      const reference = {
        project,
        changeRequestId: String(githubCase.pullRequestNumber),
      };
      const pullRequest = await github.getChangeRequest(reference);
      if (!pullRequest.ok) {
        return pullRequest.error.code === "not_found"
          ? { ok: false, reason: "not_found" }
          : readErrorResult();
      }
      const [checks, statuses] = await Promise.all([
        github.getCommitChecks({ project }, githubCase.headSha),
        github.getCommitStatuses({ project }, githubCase.headSha),
      ]);
      if (!checks.ok || !statuses.ok) return readErrorResult();
      return {
        ok: true,
        data: {
          pullRequest: {
            number: pullRequest.value.number,
            state: pullRequest.value.state,
            draft: pullRequest.value.draft,
            headSha: pullRequest.value.headSha,
            baseBranch: pullRequest.value.baseBranch,
            headBranch: pullRequest.value.headBranch,
            url: pullRequest.value.url,
            mergeability: pullRequest.value.mergeability,
            autoMergeEnabled: pullRequest.value.autoMergeEnabled,
          },
          checks: { ...checks.value, checks: [...checks.value.checks] },
          statuses: { ...statuses.value, statuses: [...statuses.value.statuses] },
        },
      };
    },
  };
}

/** Reads every `*.jsonl` file directly under `eventsDirectory` (the F008-sibling layout's own
 * `state.events` directory -- see src/infrastructure/files/layout.ts) via the existing
 * `readEventLog`, and filters to events whose `correlationId` matches this case's `runId` and
 * whose `occurredAt` falls inside the time window. No production composition currently writes to
 * this directory yet (the job-execution pipeline it belongs to has not been wired up as of this
 * task) -- reading it here is forward-compatible with the existing, already-defined layout and
 * event-log format, not a new convention this harness invents. */
async function readLocalEvents(
  eventsDirectory: string,
  inboxDirectory: string,
  runId: string,
  timeWindow: EvidenceCaseDescription["timeWindow"],
): Promise<EvidenceSourceRead<LocalEventsEvidenceData>> {
  const { readdir } = await import("node:fs/promises");
  let entries: string[];
  try {
    entries = await readdir(eventsDirectory);
  } catch (error) {
    entries =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
        ? []
        : (() => {
            throw error;
          })();
  }

  const events: LocalEventsEvidenceData["events"] = [];
  for (const entry of entries.filter((name) => name.endsWith(".jsonl")).sort()) {
    const log = await readEventLog(join(eventsDirectory, entry));
    if (!log.ok) return readErrorResult();
    for (const event of log.value.events) {
      if (event.correlationId !== runId) continue;
      if (event.occurredAt < timeWindow.from || event.occurredAt > timeWindow.to) continue;
      events.push({
        eventId: event.eventId,
        eventType: event.eventType,
        occurredAt: event.occurredAt,
        correlationId: event.correlationId,
        subjectKind: event.subject.kind,
        subjectId: event.subject.id,
      });
    }
  }

  const inbox = new DurableInbox(inboxDirectory);
  const inboxList = await inbox.list();
  if (!inboxList.ok) return readErrorResult();
  const inboxRecords = inboxList.value
    .filter((record) => record.receivedAt >= timeWindow.from && record.receivedAt <= timeWindow.to)
    .map((record) => ({
      provider: record.provider,
      deliveryId: record.deliveryId,
      eventType: record.eventType,
      receivedAt: record.receivedAt,
    }));

  if (events.length === 0 && inboxRecords.length === 0) {
    return { ok: false, reason: "empty_result" };
  }
  return { ok: true, data: { events, inboxRecords } };
}

function buildLocalEventsPort(
  eventsDirectory: string,
  inboxDirectory: string,
): EvidenceCollectorPorts["localEvents"] {
  return {
    read: (runId, timeWindow) =>
      readLocalEvents(eventsDirectory, inboxDirectory, runId, timeWindow),
  };
}

function buildCheckpointsPort(checkpointsDirectory: string): EvidenceCollectorPorts["checkpoints"] {
  return {
    async read(
      linear: EvidenceCaseDescription["linear"],
      timeWindow: EvidenceCaseDescription["timeWindow"],
    ): Promise<EvidenceSourceRead<CheckpointsEvidenceData>> {
      const found = await readCheckpointsForIssue(checkpointsDirectory, linear.issueId, timeWindow);
      if (!found.ok) return readErrorResult();
      if (found.value.length === 0) return { ok: false, reason: "empty_result" };
      return { ok: true, data: { checkpoints: [...found.value] } };
    },
  };
}

export interface BuildProductionEvidenceCollectorPortsOptions {
  readonly agentTeamHome: string;
  readonly linearApiKey: string;
  readonly githubTransport?: GhJsonTransport;
  readonly linearFetch?: typeof fetch;
}

/**
 * Assembles `EvidenceCollectorPorts` from the real O005/O006-era adapters this codebase already
 * has: `LinearReadModel` over a real `LinearGraphqlTransport`, `GitHubAdapter` over a real
 * `GhTransport` (or an injected fake transport, for the integration test), and the existing
 * `state.events`/`state.checkpoints`/`state.inbox` directories from
 * `createAgentTeamUserLayout` (src/infrastructure/files/layout.ts). Every port constructed here
 * is read-only; nothing in this function ever calls a mutation method.
 */
export function buildProductionEvidenceCollectorPorts(
  options: BuildProductionEvidenceCollectorPortsOptions,
): EvidenceCollectorPorts {
  const layout = createAgentTeamUserLayout(options.agentTeamHome);
  const linearTransport = new LinearGraphqlTransport({
    apiKey: options.linearApiKey,
    ...(options.linearFetch === undefined ? {} : { fetch: options.linearFetch }),
  });
  const githubTransport = options.githubTransport ?? new GhTransport();
  return Object.freeze({
    linear: buildLinearPort(new LinearReadModel(linearTransport)),
    github: buildGithubPort(new GitHubAdapter(githubTransport)),
    localEvents: buildLocalEventsPort(layout.state.events, layout.state.inbox),
    checkpoints: buildCheckpointsPort(layout.state.checkpoints),
  });
}
