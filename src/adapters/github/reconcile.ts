import type { ReadOptions } from "../../application/ports/common.js";
import type {
  ChangeRequestRef,
  ChangeRequestSnapshot,
  CommitChecksSnapshot,
} from "../../application/ports/source-control.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";

export interface GitHubReconcileReader {
  getChangeRequest(
    reference: ChangeRequestRef,
    options?: ReadOptions,
  ): Promise<Result<ChangeRequestSnapshot, DomainError>>;
  getCommitChecks(
    repository: { readonly project: ChangeRequestRef["project"] },
    headSha: string,
    options?: ReadOptions,
  ): Promise<Result<CommitChecksSnapshot, DomainError>>;
}

export interface LocalGitHubObservation {
  readonly state: ChangeRequestSnapshot["state"];
  readonly draft: boolean;
  readonly headSha: string;
  readonly checksAggregate?: CommitChecksSnapshot["aggregate"];
  readonly mergeAuthorizationHeadSha?: string;
}

export type GitHubReconcileFinding =
  | {
      readonly kind: "head_changed";
      readonly previous: string;
      readonly current: string;
    }
  | {
      readonly kind: "draft_changed";
      readonly previous: boolean;
      readonly current: boolean;
    }
  | {
      readonly kind: "checks_changed";
      readonly previous: CommitChecksSnapshot["aggregate"];
      readonly current: CommitChecksSnapshot["aggregate"];
      readonly headSha: string;
    }
  | {
      readonly kind: "change_request_closed";
      readonly previous: ChangeRequestSnapshot["state"];
    }
  | {
      readonly kind: "change_request_reopened";
      readonly previous: ChangeRequestSnapshot["state"];
    }
  | {
      readonly kind: "missed_merge_event";
      readonly headSha: string;
    }
  | {
      readonly kind: "out_of_process_merge";
      readonly headSha: string;
      readonly expectedHeadSha?: string;
    };

export interface GitHubReconcileSnapshot {
  readonly provider: "github";
  readonly changeRequest: ChangeRequestSnapshot;
  readonly checks: CommitChecksSnapshot;
  readonly findings: readonly GitHubReconcileFinding[];
}

function sameSha(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export class GitHubReconcileAdapter {
  constructor(readonly reader: GitHubReconcileReader) {}

  async readBack(
    reference: ChangeRequestRef,
    local: LocalGitHubObservation,
    options: ReadOptions = {},
  ): Promise<Result<GitHubReconcileSnapshot, DomainError>> {
    if (options.signal?.aborted === true) return err(domainError("interrupted"));
    const changeRequest = await this.reader.getChangeRequest(reference, options);
    if (!changeRequest.ok) return changeRequest;
    const checks = await this.reader.getCommitChecks(
      { project: reference.project },
      changeRequest.value.headSha,
      options,
    );
    if (!checks.ok) return checks;
    if (!sameSha(checks.value.headSha, changeRequest.value.headSha)) {
      return err(domainError("external_failure"));
    }

    const findings: GitHubReconcileFinding[] = [];
    if (!sameSha(local.headSha, changeRequest.value.headSha)) {
      findings.push({
        kind: "head_changed",
        previous: local.headSha,
        current: changeRequest.value.headSha,
      });
    }
    if (local.draft !== changeRequest.value.draft) {
      findings.push({
        kind: "draft_changed",
        previous: local.draft,
        current: changeRequest.value.draft,
      });
    }
    if (local.checksAggregate !== undefined && local.checksAggregate !== checks.value.aggregate) {
      findings.push({
        kind: "checks_changed",
        previous: local.checksAggregate,
        current: checks.value.aggregate,
        headSha: checks.value.headSha,
      });
    }
    if (local.state !== changeRequest.value.state) {
      if (changeRequest.value.state === "closed") {
        findings.push({ kind: "change_request_closed", previous: local.state });
      } else if (changeRequest.value.state === "open") {
        findings.push({ kind: "change_request_reopened", previous: local.state });
      } else {
        if (
          local.mergeAuthorizationHeadSha !== undefined &&
          sameSha(local.mergeAuthorizationHeadSha, changeRequest.value.headSha)
        ) {
          findings.push({ kind: "missed_merge_event", headSha: changeRequest.value.headSha });
        } else {
          findings.push({
            kind: "out_of_process_merge",
            headSha: changeRequest.value.headSha,
            ...(local.mergeAuthorizationHeadSha === undefined
              ? {}
              : { expectedHeadSha: local.mergeAuthorizationHeadSha }),
          });
        }
      }
    }
    return ok(
      Object.freeze({
        provider: "github" as const,
        changeRequest: changeRequest.value,
        checks: checks.value,
        findings: Object.freeze(findings),
      }),
    );
  }
}
