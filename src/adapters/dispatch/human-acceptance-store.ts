import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import {
  createClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import {
  humanAcceptanceIdentityDigest,
  humanAcceptanceLedgerSchema,
  humanAcceptanceRecordSchema,
  type HumanAcceptanceIdentity,
  type HumanAcceptanceInvalidationReason,
  type HumanAcceptanceLedger,
  type HumanAcceptanceRecord,
  type HumanDecision,
} from "../../domain/acceptance/index.js";
import {
  AtomicFileStore,
  acquireRecoverableFileLock,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../infrastructure/files/index.js";

export interface CreateHumanAcceptanceInput {
  readonly identity: HumanAcceptanceIdentity;
  readonly externalIssueId: string;
  readonly changeRequest: HumanAcceptanceRecord["changeRequest"];
  readonly humanSummaryDigest: string;
  readonly mergedAt: Instant;
}

export interface HumanAcceptanceStorePort {
  load(
    projectId: string,
    identityDigest: string,
  ): Promise<Result<HumanAcceptanceRecord | undefined, DomainError>>;
  listPending(projectId: string): Promise<Result<readonly HumanAcceptanceRecord[], DomainError>>;
  listForIssue(
    projectId: string,
    externalIssueId: string,
  ): Promise<Result<readonly HumanAcceptanceRecord[], DomainError>>;
  createPending(
    input: CreateHumanAcceptanceInput,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>>;
  decide(
    identity: HumanAcceptanceIdentity,
    expectedRevision: number,
    decision: HumanDecision,
    decisionReceiptId: string,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>>;
  attachAdjustment(
    identity: HumanAcceptanceIdentity,
    expectedRevision: number,
    decisionReceiptId: string,
    adjustmentIssueId: string,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>>;
  completeAdjustment(
    identity: HumanAcceptanceIdentity,
    expectedRevision: number,
    adjustmentIssueId: string,
    mergeCommit: string,
    mergedAt: Instant,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>>;
  invalidate(
    identity: HumanAcceptanceIdentity,
    expectedRevision: number,
    reason: HumanAcceptanceInvalidationReason,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>>;
}

export function defaultHumanAcceptanceDirectory(agentTeamHome: string): string {
  if (!isAbsolute(agentTeamHome)) throw new Error("agent_team_home_must_be_absolute");
  return join(agentTeamHome, "state", "dispatch", "human-acceptance");
}

type LedgerMutation = (
  ledger: HumanAcceptanceLedger,
) => Result<
  Readonly<{ ledger: HumanAcceptanceLedger; record: HumanAcceptanceRecord }>,
  DomainError
>;

function isNotFound(error: DomainError): boolean {
  return error.code === "not_found";
}

function validProjectId(projectId: string): boolean {
  return parseIdentifier("project", projectId).ok;
}

export class FileHumanAcceptanceStore implements HumanAcceptanceStorePort {
  readonly #directory: string;
  readonly #files: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    files: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("human_acceptance_root_must_be_absolute");
    this.#directory = directory;
    this.#files = files;
    this.#clock = clock;
  }

  #path(projectId: string): string {
    return join(this.#directory, `${projectId}.json`);
  }

  #lockPath(projectId: string): string {
    return `${this.#path(projectId)}.lock`;
  }

  async #read(projectId: string): Promise<Result<HumanAcceptanceLedger | undefined, DomainError>> {
    if (!validProjectId(projectId)) return err(domainError("invariant_violation"));
    const loaded = await readJsonWithSchema(this.#path(projectId), humanAcceptanceLedgerSchema);
    return !loaded.ok && isNotFound(loaded.error) ? ok(undefined) : loaded;
  }

  async load(
    projectId: string,
    identityDigest: string,
  ): Promise<Result<HumanAcceptanceRecord | undefined, DomainError>> {
    if (!/^[0-9a-f]{64}$/u.test(identityDigest)) {
      return err(domainError("invariant_violation"));
    }
    const ledger = await this.#read(projectId);
    if (!ledger.ok) return ledger;
    return ok(ledger.value?.records.find((record) => record.identityDigest === identityDigest));
  }

  async listPending(
    projectId: string,
  ): Promise<Result<readonly HumanAcceptanceRecord[], DomainError>> {
    const ledger = await this.#read(projectId);
    if (!ledger.ok) return ledger;
    return ok(
      Object.freeze(
        (ledger.value?.records ?? []).filter(
          (record) => record.state === "pending" || record.state === "adjustment_pending",
        ),
      ),
    );
  }

  async listForIssue(
    projectId: string,
    externalIssueId: string,
  ): Promise<Result<readonly HumanAcceptanceRecord[], DomainError>> {
    if (externalIssueId.trim().length === 0) return err(domainError("invariant_violation"));
    const ledger = await this.#read(projectId);
    if (!ledger.ok) return ledger;
    return ok(
      Object.freeze(
        (ledger.value?.records ?? []).filter(
          (record) => record.externalIssueId === externalIssueId,
        ),
      ),
    );
  }

  async createPending(
    input: CreateHumanAcceptanceInput,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>> {
    const identityDigest = humanAcceptanceIdentityDigest(input.identity);
    if (identityDigest === undefined) return err(domainError("invariant_violation"));
    return this.#mutate(input.identity.projectId, (ledger) => {
      const same = ledger.records.find((record) => record.identityDigest === identityDigest);
      if (same !== undefined) {
        const exactReplay =
          same.externalIssueId === input.externalIssueId &&
          JSON.stringify(same.changeRequest) === JSON.stringify(input.changeRequest) &&
          same.humanSummaryDigest === input.humanSummaryDigest &&
          same.mergedAt === input.mergedAt;
        return exactReplay ? ok({ ledger, record: same }) : err(domainError("conflict"));
      }
      const active = ledger.records.find(
        (record) =>
          record.identity.issueId === input.identity.issueId &&
          (record.state === "pending" || record.state === "adjustment_pending"),
      );
      if (active !== undefined || ledger.records.length >= 10_000) {
        return err(domainError("conflict"));
      }
      const now = this.#clock.now();
      const record = humanAcceptanceRecordSchema.safeParse({
        schemaVersion: 1,
        revision: 0,
        identityDigest,
        identity: input.identity,
        externalIssueId: input.externalIssueId,
        changeRequest: input.changeRequest,
        humanSummaryDigest: input.humanSummaryDigest,
        mergedAt: input.mergedAt,
        pendingSince: now,
        state: "pending",
        decisions: [],
        adjustments: [],
        updatedAt: now,
      });
      if (!record.success) return err(domainError("invariant_violation"));
      return ok({
        ledger: { ...ledger, records: [...ledger.records, record.data] },
        record: record.data,
      });
    });
  }

  async decide(
    identity: HumanAcceptanceIdentity,
    expectedRevision: number,
    decision: HumanDecision,
    decisionReceiptId: string,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>> {
    const identityDigest = humanAcceptanceIdentityDigest(identity);
    if (identityDigest === undefined) return err(domainError("invariant_violation"));
    return this.#mutate(identity.projectId, (ledger) => {
      const receiptOwner = ledger.records.find((record) =>
        record.decisions.some((entry) => entry.decisionReceiptId === decisionReceiptId),
      );
      if (receiptOwner !== undefined) {
        const existing = receiptOwner.decisions.find(
          (entry) => entry.decisionReceiptId === decisionReceiptId,
        );
        return receiptOwner.identityDigest === identityDigest && existing?.decision === decision
          ? ok({ ledger, record: receiptOwner })
          : err(domainError("conflict"));
      }
      const current = ledger.records.find((record) => record.identityDigest === identityDigest);
      if (
        current === undefined ||
        current.revision !== expectedRevision ||
        current.state !== "pending"
      ) {
        return err(domainError("conflict"));
      }
      const decidedAt = this.#clock.now();
      const nextDecision = {
        sequence: current.decisions.length + 1,
        decision,
        decisionReceiptId,
        decidedAt,
      } as const;
      const record = {
        ...current,
        revision: current.revision + 1,
        state: decision === "accept" ? ("accepted" as const) : ("adjustment_pending" as const),
        decisions: [...current.decisions, nextDecision],
        adjustments:
          decision === "request_adjustment"
            ? [
                ...current.adjustments,
                {
                  sequence: current.adjustments.length + 1,
                  decisionReceiptId,
                },
              ]
            : current.adjustments,
        updatedAt: decidedAt,
      };
      return this.#replace(ledger, record);
    });
  }

  async attachAdjustment(
    identity: HumanAcceptanceIdentity,
    expectedRevision: number,
    decisionReceiptId: string,
    adjustmentIssueId: string,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>> {
    return this.#updateIdentity(identity, expectedRevision, (current) => {
      const index = current.adjustments.findIndex(
        (adjustment) => adjustment.decisionReceiptId === decisionReceiptId,
      );
      const adjustment = current.adjustments[index];
      if (current.state !== "adjustment_pending" || adjustment === undefined) {
        return err(domainError("conflict"));
      }
      if (adjustment.adjustmentIssueId !== undefined) {
        return adjustment.adjustmentIssueId === adjustmentIssueId
          ? ok(current)
          : err(domainError("conflict"));
      }
      const adjustments = [...current.adjustments];
      adjustments[index] = { ...adjustment, adjustmentIssueId };
      return ok({
        ...current,
        revision: current.revision + 1,
        adjustments,
        updatedAt: this.#clock.now(),
      });
    });
  }

  async completeAdjustment(
    identity: HumanAcceptanceIdentity,
    expectedRevision: number,
    adjustmentIssueId: string,
    mergeCommit: string,
    mergedAt: Instant,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>> {
    return this.#updateIdentity(identity, expectedRevision, (current) => {
      const index = current.adjustments.findIndex(
        (adjustment) => adjustment.adjustmentIssueId === adjustmentIssueId,
      );
      const adjustment = current.adjustments[index];
      if (adjustment === undefined) return err(domainError("conflict"));
      const completion = { adjustmentIssueId, mergeCommit, mergedAt };
      if (adjustment.completion !== undefined) {
        return JSON.stringify(adjustment.completion) === JSON.stringify(completion)
          ? ok(current)
          : err(domainError("conflict"));
      }
      if (current.state !== "adjustment_pending") return err(domainError("conflict"));
      const adjustments = [...current.adjustments];
      adjustments[index] = { ...adjustment, completion };
      return ok({
        ...current,
        revision: current.revision + 1,
        state: "pending" as const,
        adjustments,
        updatedAt: this.#clock.now(),
      });
    });
  }

  async invalidate(
    identity: HumanAcceptanceIdentity,
    expectedRevision: number,
    reason: HumanAcceptanceInvalidationReason,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>> {
    return this.#updateIdentity(identity, expectedRevision, (current) => {
      if (current.state === "invalidated") {
        return current.invalidation?.reason === reason ? ok(current) : err(domainError("conflict"));
      }
      if (
        current.revision !== expectedRevision ||
        (current.state !== "pending" && current.state !== "adjustment_pending")
      ) {
        return err(domainError("conflict"));
      }
      const observedAt = this.#clock.now();
      return ok({
        ...current,
        revision: current.revision + 1,
        state: "invalidated" as const,
        invalidation: { reason, observedAt },
        updatedAt: observedAt,
      });
    });
  }

  async #updateIdentity(
    identity: HumanAcceptanceIdentity,
    expectedRevision: number,
    update: (record: HumanAcceptanceRecord) => Result<HumanAcceptanceRecord, DomainError>,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>> {
    const identityDigest = humanAcceptanceIdentityDigest(identity);
    if (identityDigest === undefined) return err(domainError("invariant_violation"));
    return this.#mutate(identity.projectId, (ledger) => {
      const current = ledger.records.find((record) => record.identityDigest === identityDigest);
      if (current === undefined) return err(domainError("not_found"));
      if (current.revision !== expectedRevision) {
        const idempotent = update(current);
        return idempotent.ok && idempotent.value === current
          ? ok({ ledger, record: current })
          : err(domainError("conflict"));
      }
      const updated = update(current);
      return updated.ok ? this.#replace(ledger, updated.value) : updated;
    });
  }

  #replace(
    ledger: HumanAcceptanceLedger,
    candidate: HumanAcceptanceRecord,
  ): Result<
    Readonly<{ ledger: HumanAcceptanceLedger; record: HumanAcceptanceRecord }>,
    DomainError
  > {
    const validated = humanAcceptanceRecordSchema.safeParse(candidate);
    if (!validated.success) return err(domainError("invariant_violation"));
    return ok({
      ledger: {
        ...ledger,
        records: ledger.records.map((record) =>
          record.identityDigest === validated.data.identityDigest ? validated.data : record,
        ),
      },
      record: validated.data,
    });
  }

  async #mutate(
    projectId: string,
    mutate: LedgerMutation,
  ): Promise<Result<HumanAcceptanceRecord, DomainError>> {
    const parsedProjectId = parseIdentifier("project", projectId);
    if (!parsedProjectId.ok) return err(domainError("invariant_violation"));
    const acquired = await acquireRecoverableFileLock(
      this.#lockPath(projectId),
      `human-acceptance:${String(process.pid)}:${randomUUID()}`,
    );
    if (!acquired.ok) return acquired;
    const current = await this.#read(projectId);
    let result: Result<HumanAcceptanceRecord, DomainError>;
    if (!current.ok) {
      result = current;
    } else {
      const ledger: HumanAcceptanceLedger = current.value ?? {
        schemaVersion: 1,
        revision: 0,
        projectId: parsedProjectId.value,
        records: [],
      };
      const mutated = mutate(ledger);
      if (!mutated.ok) {
        result = mutated;
      } else if (mutated.value.ledger === ledger) {
        result = ok(mutated.value.record);
      } else {
        const next = humanAcceptanceLedgerSchema.safeParse({
          ...mutated.value.ledger,
          revision: ledger.revision + 1,
        });
        if (!next.success) {
          result = err(domainError("invariant_violation"));
        } else {
          const written = await writeJsonWithSchema(
            this.#files,
            this.#path(projectId),
            humanAcceptanceLedgerSchema,
            next.data,
            { visibility: "private" },
          );
          result =
            written.ok && written.value.durability === "confirmed" && written.value.readBack.ok
              ? ok(mutated.value.record)
              : err(domainError("external_failure"));
        }
      }
    }
    const released = await acquired.value.release();
    return !released.ok && result.ok ? released : result;
  }
}

export function publicHumanAcceptanceProjection(record: HumanAcceptanceRecord) {
  return Object.freeze({
    projectId: record.identity.projectId,
    issueId: record.identity.issueId,
    externalIssueId: record.externalIssueId,
    state: record.state,
    pendingSince: record.pendingSince,
    changeRequestUrl: record.changeRequest.url,
    adjustmentCount: record.adjustments.length,
  });
}
