/**
 * O008 only decides from already-authoritative observations.  In particular,
 * `active` means the O007 status read-back confirmed canonical units, an
 * available Runtime, and an enabled/active timer; a rendered unit alone is
 * never sufficient.  `verified` is reserved for an O006-style Webhook health
 * check, not merely a configured URL.
 */
export const registrationSystemdWakeupStates = [
  "active",
  "not_installed",
  "runtime_unavailable",
  "inactive",
  "failed",
  "untrusted",
  "unknown",
] as const;

export type RegistrationSystemdWakeupState = (typeof registrationSystemdWakeupStates)[number];

export const registrationWebhookWakeupStates = [
  "verified",
  "unconfigured",
  "unhealthy",
  "unknown",
] as const;

export type RegistrationWebhookWakeupState = (typeof registrationWebhookWakeupStates)[number];

export interface RegistrationWakeupSources {
  readonly systemd: RegistrationSystemdWakeupState;
  readonly webhook: RegistrationWebhookWakeupState;
}

export const registrationWakeupEvidenceCodes = [
  "systemd_timer_active",
  "systemd_timer_not_installed",
  "systemd_runtime_unavailable",
  "systemd_timer_inactive",
  "systemd_timer_failed",
  "systemd_units_untrusted",
  "systemd_status_unknown",
  "webhook_runtime_verified",
  "webhook_runtime_unconfigured",
  "webhook_runtime_unhealthy",
  "webhook_runtime_unknown",
  "unattended_wakeup_available",
  "manual_reconcile_required",
] as const;

export type RegistrationWakeupEvidenceCode = (typeof registrationWakeupEvidenceCodes)[number];

export type RegistrationWakeupSourceAvailability = "available" | "unavailable" | "unknown";

export interface RegistrationWakeupSourceHealth {
  readonly state: RegistrationWakeupSourceAvailability;
  readonly evidenceCode: RegistrationWakeupEvidenceCode;
}

export type RegistrationWakeupMode =
  "unattended" | "scheduled_reconcile_only" | "event_ingest_only" | "manual_reconcile_only";

export interface RegistrationWakeupHealth {
  readonly state: "healthy" | "degraded";
  readonly mode: RegistrationWakeupMode;
  readonly capabilities: Readonly<{
    readonly scheduledReconcile: boolean;
    readonly eventDrivenIngress: boolean;
    readonly unattended: boolean;
  }>;
  readonly sources: Readonly<{
    readonly systemd: RegistrationWakeupSourceHealth;
    readonly webhook: RegistrationWakeupSourceHealth;
  }>;
  readonly evidenceCodes: readonly RegistrationWakeupEvidenceCode[];
}

const unknownSources = Object.freeze({
  systemd: "unknown",
  webhook: "unknown",
} as const satisfies RegistrationWakeupSources);

const systemdHealth: Readonly<
  Record<RegistrationSystemdWakeupState, RegistrationWakeupSourceHealth>
> = Object.freeze({
  active: Object.freeze({ state: "available", evidenceCode: "systemd_timer_active" }),
  not_installed: Object.freeze({
    state: "unavailable",
    evidenceCode: "systemd_timer_not_installed",
  }),
  runtime_unavailable: Object.freeze({
    state: "unavailable",
    evidenceCode: "systemd_runtime_unavailable",
  }),
  inactive: Object.freeze({ state: "unavailable", evidenceCode: "systemd_timer_inactive" }),
  failed: Object.freeze({ state: "unavailable", evidenceCode: "systemd_timer_failed" }),
  untrusted: Object.freeze({ state: "unavailable", evidenceCode: "systemd_units_untrusted" }),
  unknown: Object.freeze({ state: "unknown", evidenceCode: "systemd_status_unknown" }),
});

const webhookHealth: Readonly<
  Record<RegistrationWebhookWakeupState, RegistrationWakeupSourceHealth>
> = Object.freeze({
  verified: Object.freeze({ state: "available", evidenceCode: "webhook_runtime_verified" }),
  unconfigured: Object.freeze({
    state: "unavailable",
    evidenceCode: "webhook_runtime_unconfigured",
  }),
  unhealthy: Object.freeze({ state: "unavailable", evidenceCode: "webhook_runtime_unhealthy" }),
  unknown: Object.freeze({ state: "unknown", evidenceCode: "webhook_runtime_unknown" }),
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  candidate: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(candidate).sort();
  const sortedExpected = [...expected].sort();
  return (
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function systemdState(value: unknown): RegistrationSystemdWakeupState | undefined {
  return typeof value === "string" && registrationSystemdWakeupStates.includes(value as never)
    ? (value as RegistrationSystemdWakeupState)
    : undefined;
}

function webhookState(value: unknown): RegistrationWebhookWakeupState | undefined {
  return typeof value === "string" && registrationWebhookWakeupStates.includes(value as never)
    ? (value as RegistrationWebhookWakeupState)
    : undefined;
}

function parseSources(input: unknown): RegistrationWakeupSources {
  if (!isRecord(input) || !hasExactKeys(input, ["systemd", "webhook"])) return unknownSources;
  const systemd = systemdState(input["systemd"]);
  const webhook = webhookState(input["webhook"]);
  return Object.freeze({
    systemd: systemd ?? "unknown",
    webhook: webhook ?? "unknown",
  });
}

function modeFor(scheduledReconcile: boolean, eventDrivenIngress: boolean): RegistrationWakeupMode {
  if (scheduledReconcile && eventDrivenIngress) return "unattended";
  if (scheduledReconcile) return "scheduled_reconcile_only";
  if (eventDrivenIngress) return "event_ingest_only";
  return "manual_reconcile_only";
}

/**
 * Emits only fixed evidence codes. Unknown or malformed observations never
 * establish unattended operation, while a known partial capability remains
 * visible so the operator can choose the required manual reconcile route.
 */
export function evaluateRegistrationWakeupHealth(input: unknown): RegistrationWakeupHealth {
  const sources = parseSources(input);
  const systemd = systemdHealth[sources.systemd];
  const webhook = webhookHealth[sources.webhook];
  const scheduledReconcile = systemd.state === "available";
  const eventDrivenIngress = webhook.state === "available";
  const unattended = scheduledReconcile && eventDrivenIngress;
  const mode = modeFor(scheduledReconcile, eventDrivenIngress);
  const evidenceCodes = Object.freeze([
    systemd.evidenceCode,
    webhook.evidenceCode,
    unattended ? "unattended_wakeup_available" : "manual_reconcile_required",
  ] as const);

  return Object.freeze({
    state: unattended ? "healthy" : "degraded",
    mode,
    capabilities: Object.freeze({ scheduledReconcile, eventDrivenIngress, unattended }),
    sources: Object.freeze({ systemd, webhook }),
    evidenceCodes,
  });
}

export function unknownRegistrationWakeupSources(): RegistrationWakeupSources {
  return unknownSources;
}
