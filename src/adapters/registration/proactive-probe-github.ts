import { z } from "zod";

import type {
  ReadOptions,
  RegistrationProbeGitHubCapabilityPort,
  RegistrationProbeGitHubCapabilitySnapshot,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { GhTransport } from "../github/index.js";
import { GhRegistrationReadOnlyClient } from "./github.js";

const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const shaPattern = /^[0-9a-f]{40}$/iu;

const draftCandidateSchema = z
  .array(
    z
      .object({
        number: z.number().int().positive(),
        id: z.string().min(1),
        state: z.enum(["open", "closed", "merged"]),
        draft: z.boolean(),
        headRefName: z.string().min(1),
        headRefOid: z.string().regex(shaPattern),
        body: z.string(),
      })
      .strict(),
  )
  .max(2);

function failure<Value>(
  code: DomainError["code"] = "external_failure",
): Result<Value, DomainError> {
  return err(domainError(code));
}

function validRepository(value: string): boolean {
  const parts = value.split("/");
  return (
    repositoryPattern.test(value) &&
    parts.length === 2 &&
    parts.every((part) => part !== "." && part !== "..")
  );
}

function validBranch(value: string): boolean {
  return (
    branchPattern.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.endsWith(".") &&
    !value.endsWith("/") &&
    !value.endsWith(".lock")
  );
}

function encodedRepository(repository: string): string {
  return repository
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

/**
 * Reuses the same `GhTransport` (and O004's `GhRegistrationReadOnlyClient` CI read) that O004's
 * ruleset provisioning already uses, so no second independent credential/capability probe path is
 * introduced. It never mutates anything: `findDraftPullRequestByHead` is a plain GET used only for
 * exact-marker crash recovery.
 */
export class RegistrationProbeGitHubCapabilityAdapter implements RegistrationProbeGitHubCapabilityPort {
  readonly #transport: Pick<GhTransport, "inspectRepositoryCapabilities" | "requestJson">;
  readonly #continuousIntegration: Pick<
    GhRegistrationReadOnlyClient,
    "inspectContinuousIntegration"
  >;

  constructor(
    transport: Pick<
      GhTransport,
      "inspectAuthentication" | "inspectRepositoryCapabilities" | "requestJson"
    > = new GhTransport(),
    continuousIntegration: Pick<
      GhRegistrationReadOnlyClient,
      "inspectContinuousIntegration"
    > = new GhRegistrationReadOnlyClient(transport),
  ) {
    this.#transport = transport;
    this.#continuousIntegration = continuousIntegration;
  }

  async inspect(
    target: Readonly<{ repository: string; defaultBranch: string }>,
    options: ReadOptions = {},
  ): Promise<Result<RegistrationProbeGitHubCapabilitySnapshot, DomainError>> {
    if (!validRepository(target.repository) || !validBranch(target.defaultBranch)) {
      return failure("invariant_violation");
    }
    const [capability, continuousIntegration] = await Promise.all([
      this.#transport.inspectRepositoryCapabilities(
        target.repository,
        target.defaultBranch,
        options,
      ),
      this.#continuousIntegration.inspectContinuousIntegration(
        target.repository,
        target.defaultBranch,
        options,
      ),
    ]);
    if (!capability.ok) return capability;
    if (!continuousIntegration.ok) return continuousIntegration;

    const requiredCheckConfigured =
      capability.value.rulesets.available && (capability.value.rulesets.count ?? 0) > 0;
    const ci = continuousIntegration.value;
    const ciWorkflowConfirmed =
      ci.actualDefaultBranch === target.defaultBranch &&
      ci.activeWorkflowCount > 0 &&
      ci.latest !== null &&
      ci.latest.headBranch === target.defaultBranch &&
      ci.latest.conclusion === "success";
    return ok(
      Object.freeze({
        permission: capability.value.permissions.admin
          ? ("admin" as const)
          : ("read_only" as const),
        requiredCheckConfigured,
        reviewStatusSupported: capability.value.permissions.push,
        ciWorkflowConfirmed,
        pushCapable: capability.value.permissions.push,
        draftPullRequestCapable: capability.value.permissions.push,
        closeCapable: capability.value.permissions.push || capability.value.permissions.admin,
      }),
    );
  }

  async findDraftPullRequestByHead(
    target: Readonly<{ repository: string; headBranch: string }>,
    marker: string,
    options: ReadOptions = {},
  ): Promise<
    Result<
      | Readonly<{
          changeRequestId: string;
          number: number;
          headSha: string;
          state: "open" | "closed" | "merged";
          draft: boolean;
        }>
      | undefined,
      DomainError
    >
  > {
    if (
      !validRepository(target.repository) ||
      !validBranch(target.headBranch) ||
      marker.length === 0
    ) {
      return failure("invariant_violation");
    }
    const repository = encodedRepository(target.repository);
    const owner = target.repository.split("/")[0] ?? "";
    const result = await this.#transport.requestJson(
      [
        "api",
        `repos/${repository}/pulls`,
        "--method",
        "GET",
        "-f",
        "state=open",
        "-f",
        `head=${owner}:${target.headBranch}`,
        "--jq",
        "[.[] | {number,id,state,draft,headRefName:.head.ref,headRefOid:.head.sha,body}]",
      ],
      draftCandidateSchema,
      options,
    );
    if (!result.ok) return result;
    if (result.value.length > 1) return failure();
    const candidate = result.value[0];
    if (candidate === undefined) return ok(undefined);
    if (candidate.headRefName !== target.headBranch || !candidate.body.includes(marker)) {
      return ok(undefined);
    }
    return ok(
      Object.freeze({
        // `SourceControlPort.changeRequestId` is the PR number as a string, matching
        // `GitHubAdapter`'s own convention -- `candidate.id` is a separate opaque identifier.
        changeRequestId: String(candidate.number),
        number: candidate.number,
        headSha: candidate.headRefOid.toLowerCase(),
        state: candidate.state,
        draft: candidate.draft,
      }),
    );
  }
}
