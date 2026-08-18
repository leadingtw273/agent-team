import type { Checkpoint } from "../../../domain/checkpoint/index.js";
import type { Instant } from "../../../domain/foundation/index.js";
import { containsSensitiveValue } from "../../../infrastructure/redaction/index.js";
import type {
  Job,
  JobAttemptCounters,
  Lease,
  ProgressEvidenceKind,
  WatchdogDecision,
} from "../../../domain/jobs/index.js";
import type { ReconcileBlockReason } from "../../../application/reconcile/index.js";

export const runtimeBlockKinds = ["crash", "quota", "danger_approval", "unknown"] as const;

export type RuntimeBlockKind = (typeof runtimeBlockKinds)[number];
export type RuntimeQuotaWindow = "weekly" | "five_hour";
export type RuntimeDangerCategory =
  | "project_destructive"
  | "git_destructive"
  | "local_environment"
  | "deployment"
  | "external_write"
  | "secret_access"
  | "paid_action";

/**
 * A small, deliberately safe projection of an active Job. It contains no runner
 * handle, process output, command, credential, or model conversation fields.
 */
export interface RuntimeJobSummary {
  readonly id: Job["id"];
  readonly projectId: Job["projectId"];
  readonly issueId: Job["issueId"];
  readonly startedAt: NonNullable<Job["startedAt"]>;
}

/** The role and model name are display labels, never account names or configuration. */
export interface RuntimeRoleModelSummary {
  readonly role: string;
  readonly provider: string;
  readonly model: string;
}

/** Lease holder identifiers are intentionally omitted from the UI projection. */
export interface RuntimeLeaseSummary {
  readonly id: Lease["id"];
  readonly state: "active" | "expired" | "released";
  readonly acquiredAt: Lease["acquiredAt"];
  readonly expiresAt: Lease["expiresAt"];
}

export type RuntimeAttemptSummary = Readonly<Pick<JobAttemptCounters, keyof JobAttemptCounters>>;

/** Only C012's effective progress evidence kinds can reach this projection. */
export interface RuntimeEffectiveProgress {
  readonly kind: ProgressEvidenceKind;
  readonly occurredAt: Instant;
  readonly summary: string;
}

export interface RuntimeWatchdogSummary {
  readonly elapsedMinutes: number;
  readonly decision: WatchdogDecision;
  readonly extensionGranted: Job["watchdogExtensionGranted"];
}

/**
 * A Checkpoint projection deliberately omits worktree paths, raw test commands,
 * full error logs, requirement content, and model conversation data.
 */
export interface RuntimeCheckpointSummary {
  readonly id: Checkpoint["id"];
  readonly createdAt: Checkpoint["createdAt"];
  readonly reason: Checkpoint["reason"];
  readonly completedItemCount: number;
  readonly remainingItemCount: number;
  readonly testCounts: Readonly<{
    readonly passed: number;
    readonly failed: number;
    readonly notRun: number;
  }>;
  readonly nextStep: string;
}

/** LWS07: closed, local-only lifecycle projection; never contains adapter or provider payloads. */
export interface RuntimeWorkStatusLifecycleSummary {
  readonly mode: "off" | "observe" | "enforce";
  readonly phase:
    | "idle"
    | "work_start_pending"
    | "working"
    | "review_start_pending"
    | "reviewing"
    | "fix_pending"
    | "blocked_pending_mutation"
    | "requires_manual"
    | "completed"
    | "canceled";
  readonly expectedLinearStateId: string | null;
  readonly observedLinearStateId: string | null;
  readonly transitionInstance: string | null;
  readonly pendingMutation: Readonly<{
    step: string;
    consecutiveFailureCount: number;
    lastAttemptAt: Instant;
  }> | null;
  readonly authority: Readonly<{
    jobId: string;
    leaseExpiresAt: Instant;
  }> | null;
  readonly incident: Readonly<{
    kind: "main" | "agent" | "bootstrap";
    reasonCode: string;
    attemptCount: number;
  }> | null;
  readonly capability: Readonly<{
    checkedAt: Instant | null;
    workflowStatesReady: boolean;
    agentLabelsReady: boolean;
    reasonCodesReady: boolean;
  }>;
}

interface RuntimeBlockBase {
  readonly summary: string;
  readonly nextStep: string;
}

export type RuntimeBlock =
  | (RuntimeBlockBase &
      Readonly<{
        readonly kind: "crash";
        readonly reconcileReason: Extract<
          ReconcileBlockReason,
          "checkpoint_missing" | "lease_unavailable" | "recovery_limit_reached"
        >;
        readonly processRecoveriesUsed: number;
        readonly processRecoveriesLimit: number;
      }>)
  | (RuntimeBlockBase &
      Readonly<{
        readonly kind: "quota";
        readonly quotaWindows: readonly RuntimeQuotaWindow[];
      }>)
  | (RuntimeBlockBase &
      Readonly<{
        readonly kind: "danger_approval";
        readonly category: RuntimeDangerCategory;
      }>)
  | (RuntimeBlockBase &
      Readonly<{
        readonly kind: "unknown";
        readonly reconcileReason: Extract<
          ReconcileBlockReason,
          "source_unavailable" | "event_repair_unconfirmed"
        >;
      }>);

export interface RuntimeStatusItem {
  readonly state: "running" | "checkpointed" | "blocked";
  readonly job: RuntimeJobSummary;
  readonly roleModel: RuntimeRoleModelSummary;
  readonly lease: RuntimeLeaseSummary;
  readonly attempts: RuntimeAttemptSummary;
  readonly lastEffectiveProgress?: RuntimeEffectiveProgress;
  readonly watchdog: RuntimeWatchdogSummary;
  readonly checkpoint?: RuntimeCheckpointSummary;
  readonly workStatusLifecycle?: RuntimeWorkStatusLifecycleSummary;
  readonly block?: RuntimeBlock;
  readonly nextStep: string;
}

export interface RuntimeStatusReadModel {
  readonly source: "fixture" | "runtime";
  readonly listRuntimeStatuses: () => readonly RuntimeStatusItem[];
}

const safeSummaryMaximumLength = 240;
const safeLabelMaximumLength = 80;
const safeIdentifierMaximumLength = 1_024;
const safeTimestampMaximumLength = 80;
const runtimeSummaryPlaceholder = "已隱藏不安全的原始內容";
const runtimeLabelPlaceholder = "未提供安全摘要";
const runtimeIdentifierPlaceholder = "已隱藏不安全的識別資訊";
const runtimeTimestampPlaceholder = "未提供安全時間";
const unsafeRuntimeSummaryPattern =
  /(?:authorization\s*[:=]|bearer\s+[a-z0-9._~+/=-]+|(?:api[_ -]?key|secret|token|password)\s*[:=]|-----begin|(?:^|\s)(?:curl|wget|rm|bash|zsh|sh|node|pnpm|git)\b|hidden\s+reasoning|chain\s+of\s+thought)/iu;

function normalizedRuntimeText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/gu, " ").trim();
  return normalized.length === 0 ||
    normalized.length > maximumLength ||
    containsSensitiveValue(normalized)
    ? undefined
    : normalized;
}

function containsProhibitedRuntimeSummary(value: string): boolean {
  return unsafeRuntimeSummaryPattern.test(value);
}

/**
 * Read models must provide human-readable summaries, not raw diagnostic payloads.
 * The view applies this final defensive check so a mistaken adapter value becomes a
 * fixed safe placeholder rather than content exposed in the localhost UI.
 */
export function safeRuntimeSummary(value: string): string {
  const normalized = normalizedRuntimeText(value, safeSummaryMaximumLength);
  return normalized === undefined || containsProhibitedRuntimeSummary(normalized)
    ? runtimeSummaryPlaceholder
    : normalized;
}

export function safeRuntimeLabel(value: string): string {
  const normalized = normalizedRuntimeText(value, safeLabelMaximumLength);
  return normalized !== undefined && /^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,79}$/u.test(normalized)
    ? normalized
    : runtimeLabelPlaceholder;
}

export function safeRuntimeIdentifier(value: string): string {
  return normalizedRuntimeText(value, safeIdentifierMaximumLength) ?? runtimeIdentifierPlaceholder;
}

export function safeRuntimeTimestamp(value: string): string {
  return normalizedRuntimeText(value, safeTimestampMaximumLength) ?? runtimeTimestampPlaceholder;
}
