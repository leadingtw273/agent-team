import type { RegistrationSetupGateEvidencePort } from "../../application/registration/index.js";
import type { ReadOptions, SourceControlPort } from "../../application/ports/index.js";
import { domainError, err, ok } from "../../domain/foundation/index.js";
import { projectSchema } from "../../domain/project/index.js";
import { sha256Digest } from "../../domain/review/index.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,220}$/u;

function evidenceUrl(value: string | undefined): value is string {
  if (value === undefined) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

/** Read-only exact-head CI + fresh-review evidence adapter. */
export class SourceControlRegistrationSetupGateEvidence implements RegistrationSetupGateEvidencePort {
  readonly #sourceControl: Pick<SourceControlPort, "getCommitChecks" | "getCommitStatuses">;

  constructor(sourceControl: Pick<SourceControlPort, "getCommitChecks" | "getCommitStatuses">) {
    this.#sourceControl = sourceControl;
  }

  async read(
    command: Parameters<RegistrationSetupGateEvidencePort["read"]>[0],
    options: ReadOptions = {},
  ) {
    const parsedProject = projectSchema.safeParse(command.project);
    if (
      !parsedProject.success ||
      !identifierPattern.test(command.changeRequestId) ||
      !shaPattern.test(command.expectedHeadSha) ||
      !digestPattern.test(command.requirementsDigest) ||
      !digestPattern.test(command.diffDigest)
    ) {
      return err(domainError("invariant_violation"));
    }
    const repository = { project: parsedProject.data };
    const checks = await this.#sourceControl.getCommitChecks(
      repository,
      command.expectedHeadSha,
      options,
    );
    if (!checks.ok) return checks;
    if (checks.value.headSha.toLowerCase() !== command.expectedHeadSha.toLowerCase()) {
      return err(domainError("conflict"));
    }
    if (checks.value.aggregate !== "success" || checks.value.checks.length === 0) {
      return ok({
        state: "not_ready" as const,
        reason:
          checks.value.aggregate === "pending" ? ("ci_pending" as const) : ("ci_failed" as const),
      });
    }
    if (
      checks.value.checks.some(
        (check) => check.status !== "completed" || check.conclusion !== "success",
      )
    ) {
      return ok({ state: "not_ready" as const, reason: "ci_failed" as const });
    }
    const ciChecksDigest = sha256Digest({
      schemaVersion: 1,
      headSha: checks.value.headSha.toLowerCase(),
      checks: [...checks.value.checks]
        .map((check) => ({
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
          url: check.url ?? null,
        }))
        .sort((left, right) =>
          `${left.name}\0${left.url ?? ""}`.localeCompare(`${right.name}\0${right.url ?? ""}`),
        ),
    });
    if (!ciChecksDigest.ok) return ciChecksDigest;

    const statuses = await this.#sourceControl.getCommitStatuses(
      repository,
      command.expectedHeadSha,
      options,
    );
    if (!statuses.ok) return statuses;
    if (statuses.value.headSha.toLowerCase() !== command.expectedHeadSha.toLowerCase()) {
      return err(domainError("conflict"));
    }
    const reviews = statuses.value.statuses.filter(
      (status) => status.context === "agent-team/review",
    );
    const review = reviews[0];
    if (reviews.length !== 1 || review?.state !== "success") {
      return ok({
        state: "not_ready" as const,
        reason:
          review?.state === "pending" ? ("review_pending" as const) : ("review_failed" as const),
      });
    }
    if (!evidenceUrl(review.targetUrl)) {
      return ok({ state: "not_ready" as const, reason: "review_failed" as const });
    }
    const base = {
      schemaVersion: 1 as const,
      source: "source_control" as const,
      projectId: parsedProject.data.id,
      repository: parsedProject.data.sourceControl.repository,
      changeRequestId: command.changeRequestId,
      headSha: command.expectedHeadSha.toLowerCase(),
      requirementsDigest: command.requirementsDigest,
      diffDigest: command.diffDigest,
      ciChecksDigest: ciChecksDigest.value,
      reviewContext: "agent-team/review" as const,
      reviewEvidenceUrl: review.targetUrl,
    };
    const evidenceDigest = sha256Digest({
      kind: "registration_setup_gate_evidence",
      ...base,
    });
    if (!evidenceDigest.ok) return evidenceDigest;
    return ok({
      state: "ready" as const,
      receipt: Object.freeze({
        ...base,
        evidenceDigest: evidenceDigest.value,
      }),
    });
  }
}
