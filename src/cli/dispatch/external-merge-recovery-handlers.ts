import type { FileJobProgressStore, JobProgressRecord } from "../../adapters/dispatch/index.js";
import { domainError, err, type DomainError, type Result } from "../../domain/foundation/index.js";
import { jobIdSchema } from "../../domain/jobs/index.js";
import { headShaSchema } from "../../domain/review/index.js";
import type { CliCommandOutcome } from "../program.js";
import { readStdinConfirmation } from "../registration/confirmation.js";

export const acknowledgeExternalMergeConfirmationPhrase = "ACKNOWLEDGE EXTERNAL MERGE" as const;
export const acknowledgeExternalMergeWithoutAcceptanceConfirmationPhrase =
  "ACKNOWLEDGE EXTERNAL MERGE WITHOUT HUMAN ACCEPTANCE" as const;

export interface AcknowledgeExternalMergeInput {
  readonly jobId: string;
  readonly prNumber: number | string;
  readonly headSha: string;
  readonly mergeCommitSha: string;
  readonly allowMissingHumanAcceptance?: boolean;
  readonly dryRun?: boolean;
}

export interface ValidatedExternalMergeInput {
  readonly jobId: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mergeCommitSha: string;
  readonly allowMissingHumanAcceptance: boolean;
}

export interface ExternalMergeRecoveryReceipt {
  readonly mode: "recovered" | "finalized" | "already_finalized";
  readonly jobId: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mergeCommitSha: string;
  readonly headDrift: boolean;
  readonly humanAcceptanceException: boolean;
  readonly admissionReleased: "released" | "already_released" | "not_found";
  readonly leaseReleased: boolean;
}

export interface ExternalMergeRecoveryInspection {
  readonly mode: "recoverable" | "finalizable";
  readonly jobId: string;
  readonly prNumber: number;
  readonly headSha: string;
  readonly mergeCommitSha: string;
  readonly headDrift: boolean;
  readonly humanAcceptanceException: boolean;
}

export interface ExternalMergeRecoveryPort {
  inspect(
    record: JobProgressRecord,
    input: ValidatedExternalMergeInput,
  ): Promise<Result<ExternalMergeRecoveryInspection, DomainError>>;
  recover(
    record: JobProgressRecord,
    input: ValidatedExternalMergeInput,
  ): Promise<Result<ExternalMergeRecoveryReceipt, DomainError>>;
}

export interface CreateAcknowledgeExternalMergeHandlerOptions {
  readonly progress: FileJobProgressStore;
  readonly authority: ExternalMergeRecoveryPort;
  readonly stdin?: AsyncIterable<Uint8Array | string>;
}

function outcome(
  state: "success" | "failed" | "blocked" | "rejected",
  payload: unknown,
): CliCommandOutcome {
  return { state, message: JSON.stringify(payload) };
}

function validateInput(
  input: AcknowledgeExternalMergeInput,
): Result<ValidatedExternalMergeInput, DomainError> {
  const jobId = jobIdSchema.safeParse(input.jobId);
  const prNumber =
    typeof input.prNumber === "string"
      ? /^\d+$/u.test(input.prNumber)
        ? Number(input.prNumber)
        : Number.NaN
      : input.prNumber;
  const exactHeadSha = /^[0-9a-f]{40}$/u;
  const headSha = headShaSchema.safeParse(input.headSha.toLowerCase());
  const mergeCommitSha = headShaSchema.safeParse(input.mergeCommitSha.toLowerCase());
  if (
    !jobId.success ||
    !Number.isSafeInteger(prNumber) ||
    prNumber <= 0 ||
    !exactHeadSha.test(input.headSha.toLowerCase()) ||
    !exactHeadSha.test(input.mergeCommitSha.toLowerCase()) ||
    !headSha.success ||
    !mergeCommitSha.success
  ) {
    return err(domainError("invariant_violation"));
  }
  return {
    ok: true,
    value: {
      jobId: jobId.data,
      prNumber,
      headSha: headSha.data,
      mergeCommitSha: mergeCommitSha.data,
      allowMissingHumanAcceptance: input.allowMissingHumanAcceptance === true,
    },
  };
}

export function createAcknowledgeExternalMergeHandler(
  options: CreateAcknowledgeExternalMergeHandlerOptions,
): (input: AcknowledgeExternalMergeInput) => Promise<CliCommandOutcome> {
  const stdin = options.stdin ?? process.stdin;
  return async (input) => {
    const validated = validateInput(input);
    if (!validated.ok) {
      return outcome("rejected", {
        operation: "acknowledge_external_merge",
        state: "rejected",
        reason: "invalid_input",
      });
    }

    const loaded = await options.progress.load(validated.value.jobId);
    if (!loaded.ok || loaded.value === undefined) {
      return outcome(loaded.ok ? "blocked" : "failed", {
        operation: "acknowledge_external_merge",
        state: "blocked",
        reason: loaded.ok ? "job_not_found" : "job_progress_read_failed",
        ...(loaded.ok ? {} : { errorCode: loaded.error.code }),
      });
    }

    if (input.dryRun === true) {
      const inspected = await options.authority.inspect(loaded.value, validated.value);
      return inspected.ok
        ? outcome("success", {
            operation: "acknowledge_external_merge",
            state: "admissible",
            dryRun: true,
            ...inspected.value,
          })
        : outcome("blocked", {
            operation: "acknowledge_external_merge",
            state: "blocked",
            dryRun: true,
            reason: "authority_unavailable",
            errorCode: inspected.error.code,
          });
    }

    const confirmation = await readStdinConfirmation(stdin);
    const requiredPhrase = validated.value.allowMissingHumanAcceptance
      ? acknowledgeExternalMergeWithoutAcceptanceConfirmationPhrase
      : acknowledgeExternalMergeConfirmationPhrase;
    if (!confirmation.ok || confirmation.value !== requiredPhrase) {
      return outcome("rejected", {
        operation: "acknowledge_external_merge",
        state: "rejected",
        reason: "confirmation_mismatch",
      });
    }

    const recovered = await options.authority.recover(loaded.value, validated.value);
    const failureState =
      recovered.ok || ["conflict", "permission_denied", "not_found"].includes(recovered.error.code)
        ? "blocked"
        : "failed";
    return recovered.ok
      ? outcome("success", {
          operation: "acknowledge_external_merge",
          state: "completed",
          ...recovered.value,
        })
      : outcome(failureState, {
          operation: "acknowledge_external_merge",
          state: failureState,
          reason: "authority_unavailable",
          errorCode: recovered.error.code,
        });
  };
}
