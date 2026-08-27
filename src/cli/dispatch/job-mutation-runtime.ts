import { LocalGitAdapter } from "../../adapters/git/index.js";
import { GitHubAdapter, type GhJsonTransport, GhTransport } from "../../adapters/github/index.js";
import type { FileJobProgressStore, JobProgressRecord } from "../../adapters/dispatch/index.js";
import {
  JobPrLifecyclePublisher,
  createJobPrLifecycleEvent,
  parsePullRequestBackPointer,
} from "../../application/pipelines/index.js";
import {
  domainError,
  err,
  ok,
  type Clock,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { Project } from "../../domain/project/index.js";
import { headShaSchema } from "../../domain/review/index.js";
import type { WorkManagementPort } from "../../application/ports/index.js";
import {
  buildImplementerPipeline,
  type BuildImplementerPipelineResult,
} from "./implementer-composition.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";
import { createJobPrAuthorityValidator } from "./job-pr-authority-validator.js";
import {
  FileManagedMutationAuthority,
  fenceGitPort,
  fenceSourceControlPort,
  type WorkManagementLifecyclePort,
} from "./managed-mutation-authority.js";

export interface JobMutationRuntimeOptions {
  readonly agentTeamHome: string;
  readonly project: Project;
  readonly progress: FileJobProgressStore;
  readonly workManagement: Pick<WorkManagementPort, "getIssue" | "listComments" | "appendComment">;
  readonly escalationWorkManagement?: WorkManagementLifecyclePort;
  readonly codexConfig: DispatchProviderConfig["codex"];
  readonly clock: Clock;
  readonly githubTransport?: GhJsonTransport & Pick<GhTransport, "inspectAuthentication">;
  readonly buildPipeline?: typeof buildImplementerPipeline;
}

export function fencedLifecyclePublisher(
  workManagement: Pick<WorkManagementPort, "listComments" | "appendComment">,
  authority: FileManagedMutationAuthority,
): JobPrLifecyclePublisher {
  return new JobPrLifecyclePublisher({
    listComments: (reference, options) => workManagement.listComments(reference, options),
    appendComment: (reference, body, options) =>
      authority.execute(
        {
          intent: "linear_lifecycle",
          idempotencyKey: options.idempotencyKey,
          identity: {
            projectId: reference.project.id,
            externalIssueId: reference.externalIssueId,
            body,
          },
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
        (stable) => workManagement.appendComment(reference, body, stable),
      ),
  });
}

function authorityFor(
  options: JobMutationRuntimeOptions,
  record: JobProgressRecord,
  github: GitHubAdapter,
): Result<FileManagedMutationAuthority, DomainError> {
  const fence = record.controlFence;
  if (fence?.state !== "active") return err(domainError("permission_denied"));
  return ok(
    new FileManagedMutationAuthority({
      progress: options.progress,
      jobId: record.jobId,
      expectedFence: {
        leaseId: fence.leaseId,
        holderId: fence.holderId,
        leaseEpoch: fence.leaseEpoch,
        ownershipEpoch: fence.ownershipEpoch,
      },
      clock: options.clock,
      validateAuthority: createJobPrAuthorityValidator({
        project: options.project,
        workManagement: options.workManagement,
        sourceControl: github,
      }),
      ...(options.escalationWorkManagement === undefined
        ? {}
        : {
            escalation: {
              project: options.project,
              workManagement: options.escalationWorkManagement,
              sourceControl: github,
            },
          }),
    }),
  );
}

export class JobMutationRuntime {
  constructor(readonly options: JobMutationRuntimeOptions) {}

  async ensureJobStarted(record: JobProgressRecord): Promise<Result<void, DomainError>> {
    const github = new GitHubAdapter(this.options.githubTransport ?? new GhTransport());
    const authority = authorityFor(this.options, record, github);
    if (!authority.ok) return authority;
    const event = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "job_started",
      projectId: record.projectId,
      issueId: record.issueId,
      jobId: record.jobId,
    });
    if (!event.ok) return event;
    const publisher = this.#publisher(authority.value);
    const published = await publisher.publish({
      issue: { project: this.options.project, externalIssueId: record.externalIssueId },
      humanSummary: `Agent Team 已開始 Job ${record.jobId}。`,
      event: event.value,
    });
    return published.ok ? ok(undefined) : published;
  }

  /** Repairs only the public identity steps that can be proven from the deterministic branch and
   * immutable PR back-pointer. It never creates a PR or guesses between multiple candidates. */
  async repairPublicAuthority(
    initialRecord: JobProgressRecord,
  ): Promise<Result<JobProgressRecord, DomainError>> {
    if (
      initialRecord.controlFence !== undefined &&
      initialRecord.controlFence.ownershipEpoch > 0 &&
      initialRecord.changeRequestId !== undefined &&
      initialRecord.headSha !== undefined
    ) {
      return ok(initialRecord);
    }
    const started = await this.ensureJobStarted(initialRecord);
    if (!started.ok) return started;
    const loaded = await this.options.progress.load(initialRecord.jobId);
    if (!loaded.ok || loaded.value === undefined) {
      return loaded.ok ? err(domainError("not_found")) : loaded;
    }
    let record = loaded.value;
    const github = new GitHubAdapter(this.options.githubTransport ?? new GhTransport());
    if (record.changeRequestId === undefined) {
      const candidates = await github.findOpenChangeRequestsByHead(
        { project: this.options.project },
        record.branch,
      );
      if (!candidates.ok) return candidates;
      if (candidates.value.length === 0) return ok(record);
      if (candidates.value.length !== 1) return err(domainError("conflict"));
      const candidate = candidates.value[0];
      if (candidate === undefined) return err(domainError("conflict"));
      const pointer = parsePullRequestBackPointer(candidate.body ?? "");
      const pointerValue = pointer.ok ? pointer.value : undefined;
      const candidateHead = headShaSchema.safeParse(candidate.headSha);
      if (
        !pointer.ok ||
        pointerValue?.projectId !== record.projectId ||
        pointerValue.issueId !== record.issueId ||
        pointerValue.jobId !== record.jobId ||
        pointerValue.branch !== record.branch ||
        !candidateHead.success ||
        candidate.headBranch !== record.branch ||
        (record.headSha !== undefined && candidate.headSha !== record.headSha)
      ) {
        return err(domainError("conflict"));
      }
      const attached = await this.options.progress.compareAndSwap(record.jobId, record.revision, {
        ...(() => {
          const {
            schemaVersion: _schemaVersion,
            revision: _revision,
            updatedAt: _updatedAt,
            ...mutation
          } = record;
          void _schemaVersion;
          void _revision;
          void _updatedAt;
          return mutation;
        })(),
        changeRequestId: String(candidate.number),
        headSha: candidateHead.data,
      });
      if (!attached.ok) return attached;
      record = attached.value;
    }
    if (record.controlFence?.ownershipEpoch !== 0) return ok(record);
    if (record.changeRequestId === undefined || record.headSha === undefined) {
      return err(domainError("conflict"));
    }
    const prNumber = Number.parseInt(record.changeRequestId, 10);
    if (!Number.isSafeInteger(prNumber) || prNumber <= 0) return err(domainError("conflict"));
    return this.bindPullRequest(record, prNumber, record.headSha);
  }

  async buildImplementer(record: JobProgressRecord): Promise<BuildImplementerPipelineResult> {
    const transport = this.options.githubTransport ?? new GhTransport();
    const github = new GitHubAdapter(transport);
    const authority = authorityFor(this.options, record, github);
    if (!authority.ok) {
      return Object.freeze({ state: "blocked", reason: "github_authentication_unavailable" });
    }
    return (this.options.buildPipeline ?? buildImplementerPipeline)({
      agentTeamHome: this.options.agentTeamHome,
      codexConfig: this.options.codexConfig,
      githubTransport: transport,
      gitPort: fenceGitPort(new LocalGitAdapter(), authority.value),
      sourceControlPort: fenceSourceControlPort(github, authority.value),
    });
  }

  async bindPullRequest(
    record: JobProgressRecord,
    prNumber: number,
    expectedHeadSha: string,
  ): Promise<Result<JobProgressRecord, DomainError>> {
    if (record.changeRequestId !== String(prNumber) || record.controlFence?.ownershipEpoch !== 0) {
      return err(domainError("conflict"));
    }
    const github = new GitHubAdapter(this.options.githubTransport ?? new GhTransport());
    const current = await github.getChangeRequest({
      project: this.options.project,
      changeRequestId: String(prNumber),
    });
    if (
      !current.ok ||
      current.value.state !== "open" ||
      current.value.headBranch !== record.branch ||
      current.value.headSha !== expectedHeadSha
    ) {
      return current.ok ? err(domainError("conflict")) : current;
    }
    const authority = authorityFor(this.options, record, github);
    if (!authority.ok) return authority;
    const event = createJobPrLifecycleEvent({
      schemaVersion: 1,
      kind: "pr_bound",
      projectId: record.projectId,
      issueId: record.issueId,
      jobId: record.jobId,
      prNumber,
      branch: record.branch,
      initialHeadSha: expectedHeadSha,
      ownershipEpoch: 1,
    });
    if (!event.ok) return event;
    const publisher = this.#publisher(authority.value);
    const published = await publisher.publish({
      issue: { project: this.options.project, externalIssueId: record.externalIssueId },
      humanSummary: `Agent Team 已將 PR #${String(prNumber)} 綁定至 Job ${record.jobId}。`,
      event: event.value,
    });
    if (!published.ok) return published;
    const refreshed = await this.options.progress.load(record.jobId);
    if (!refreshed.ok || refreshed.value === undefined) {
      return refreshed.ok ? err(domainError("not_found")) : refreshed;
    }
    const fence = refreshed.value.controlFence;
    if (
      fence?.state !== "active" ||
      fence.leaseId !== record.controlFence.leaseId ||
      fence.holderId !== record.controlFence.holderId ||
      fence.leaseEpoch !== record.controlFence.leaseEpoch ||
      fence.ownershipEpoch !== 0
    ) {
      return err(domainError("conflict"));
    }
    return this.options.progress.compareAndSwap(record.jobId, refreshed.value.revision, {
      ...(() => {
        const {
          schemaVersion: _schemaVersion,
          revision: _revision,
          updatedAt: _updatedAt,
          ...mutation
        } = refreshed.value;
        void _schemaVersion;
        void _revision;
        void _updatedAt;
        return mutation;
      })(),
      controlFence: { ...fence, ownershipEpoch: 1 },
    });
  }

  #publisher(authority: FileManagedMutationAuthority): JobPrLifecyclePublisher {
    return fencedLifecyclePublisher(this.options.workManagement, authority);
  }
}
