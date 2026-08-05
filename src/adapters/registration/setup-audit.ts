import type {
  RegistrationSetupAuditIntent,
  RegistrationSetupAuditPort,
  RegistrationSetupAuditReceipt,
} from "../../application/registration/index.js";
import type { MutationOptions } from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  parseInstant,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { sha256Digest } from "../../domain/review/index.js";

const digestPattern = /^[0-9a-f]{64}$/u;
const shaPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,220}$/u;

export interface RegistrationSetupExternalAuditCommentReceipt {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly reused: boolean;
}

export interface LinearAuditCommentWriter {
  appendComment(
    linearAuditIssueId: string,
    body: string,
    idempotencyKey: string,
  ): Promise<Result<RegistrationSetupExternalAuditCommentReceipt, DomainError>>;
}

export interface PullRequestAuditCommentWriter {
  appendChangeRequestComment(
    changeRequest: Readonly<{
      projectId: string;
      repository: string;
      changeRequestId: string;
    }>,
    exactHead: string,
    body: string,
    options: MutationOptions,
  ): Promise<Result<RegistrationSetupExternalAuditCommentReceipt, DomainError>>;
}

function validIntent(intent: RegistrationSetupAuditIntent, options: MutationOptions): boolean {
  const raw = intent as unknown as Readonly<Record<string, unknown>>;
  const expectedKeys = [
    "body",
    "bodyDigest",
    "changeRequestId",
    "destination",
    "diffDigest",
    "evidenceDigest",
    "headSha",
    "idempotencyKey",
    "kind",
    "linearAuditIssueId",
    "projectId",
    "repository",
    "requirementsDigest",
    "schemaVersion",
    "setupSessionId",
  ];
  const bodyDigest = sha256Digest(intent.body);
  return (
    Object.keys(intent).sort().join("\0") === expectedKeys.sort().join("\0") &&
    raw["schemaVersion"] === 1 &&
    raw["kind"] === "registration_setup_user_approval_required" &&
    (raw["destination"] === "linear" || raw["destination"] === "pull_request") &&
    identifierPattern.test(intent.setupSessionId) &&
    identifierPattern.test(intent.projectId) &&
    identifierPattern.test(intent.linearAuditIssueId) &&
    identifierPattern.test(intent.changeRequestId) &&
    intent.repository.trim().length > 0 &&
    shaPattern.test(intent.headSha) &&
    digestPattern.test(intent.requirementsDigest) &&
    digestPattern.test(intent.diffDigest) &&
    digestPattern.test(intent.evidenceDigest) &&
    bodyDigest.ok &&
    bodyDigest.value === intent.bodyDigest &&
    intent.idempotencyKey === options.idempotencyKey
  );
}

/** Holds only the two narrow comment capabilities; it cannot merge a PR. */
export class RegistrationSetupAuditAdapter implements RegistrationSetupAuditPort {
  readonly #linear: LinearAuditCommentWriter;
  readonly #pullRequest: PullRequestAuditCommentWriter;

  constructor(linear: LinearAuditCommentWriter, pullRequest: PullRequestAuditCommentWriter) {
    this.#linear = linear;
    this.#pullRequest = pullRequest;
  }

  async publish(intent: RegistrationSetupAuditIntent, options: MutationOptions) {
    if (!validIntent(intent, options)) return err(domainError("invariant_violation"));
    const published =
      intent.destination === "linear"
        ? await this.#linear.appendComment(
            intent.linearAuditIssueId,
            intent.body,
            intent.idempotencyKey,
          )
        : await this.#pullRequest.appendChangeRequestComment(
            {
              projectId: intent.projectId,
              repository: intent.repository,
              changeRequestId: intent.changeRequestId,
            },
            intent.headSha,
            intent.body,
            options,
          );
    if (!published.ok) return published;
    const createdAt = parseInstant(published.value.createdAt);
    if (
      !identifierPattern.test(published.value.id) ||
      published.value.body !== intent.body ||
      !createdAt.ok
    ) {
      return err(domainError("conflict"));
    }
    const idempotencyKeyDigest = sha256Digest(intent.idempotencyKey);
    if (!idempotencyKeyDigest.ok) return idempotencyKeyDigest;
    const { kind, body, idempotencyKey, ...binding } = intent;
    void kind;
    void body;
    void idempotencyKey;
    return ok(
      Object.freeze({
        ...binding,
        externalCommentId: published.value.id,
        idempotencyKeyDigest: idempotencyKeyDigest.value,
        createdAt: createdAt.value,
        reused: published.value.reused,
      }) as RegistrationSetupAuditReceipt,
    );
  }
}
