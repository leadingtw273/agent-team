import { describe, expect, it } from "vitest";

import {
  evaluateRegistrationWakeupHealth,
  registrationWakeupEvidenceCodes,
} from "../../src/application/registration/index.js";

function sourceState(value: string, available: string): "available" | "unavailable" | "unknown" {
  if (value === available) return "available";
  return value === "unknown" ? "unknown" : "unavailable";
}

describe("O008 Registration wake-up health", () => {
  it("keeps its source states and evidence codes closed", () => {
    expect(registrationWakeupEvidenceCodes).toEqual([
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
    ]);
  });

  it.each([
    {
      name: "no source",
      sources: { systemd: "not_installed", webhook: "unconfigured" },
      expected: {
        state: "degraded",
        mode: "manual_reconcile_only",
        capabilities: { scheduledReconcile: false, eventDrivenIngress: false, unattended: false },
        evidenceCodes: [
          "systemd_timer_not_installed",
          "webhook_runtime_unconfigured",
          "manual_reconcile_required",
        ],
      },
    },
    {
      name: "only systemd",
      sources: { systemd: "active", webhook: "unconfigured" },
      expected: {
        state: "degraded",
        mode: "scheduled_reconcile_only",
        capabilities: { scheduledReconcile: true, eventDrivenIngress: false, unattended: false },
        evidenceCodes: [
          "systemd_timer_active",
          "webhook_runtime_unconfigured",
          "manual_reconcile_required",
        ],
      },
    },
    {
      name: "only verified webhook",
      sources: { systemd: "not_installed", webhook: "verified" },
      expected: {
        state: "degraded",
        mode: "event_ingest_only",
        capabilities: { scheduledReconcile: false, eventDrivenIngress: true, unattended: false },
        evidenceCodes: [
          "systemd_timer_not_installed",
          "webhook_runtime_verified",
          "manual_reconcile_required",
        ],
      },
    },
    {
      name: "both authoritative sources",
      sources: { systemd: "active", webhook: "verified" },
      expected: {
        state: "healthy",
        mode: "unattended",
        capabilities: { scheduledReconcile: true, eventDrivenIngress: true, unattended: true },
        evidenceCodes: [
          "systemd_timer_active",
          "webhook_runtime_verified",
          "unattended_wakeup_available",
        ],
      },
    },
    {
      name: "unknown source fails closed while preserving confirmed systemd capability",
      sources: { systemd: "active", webhook: "unknown" },
      expected: {
        state: "degraded",
        mode: "scheduled_reconcile_only",
        capabilities: { scheduledReconcile: true, eventDrivenIngress: false, unattended: false },
        evidenceCodes: [
          "systemd_timer_active",
          "webhook_runtime_unknown",
          "manual_reconcile_required",
        ],
      },
    },
    {
      name: "unhealthy sources never count as wake-up availability",
      sources: { systemd: "failed", webhook: "unhealthy" },
      expected: {
        state: "degraded",
        mode: "manual_reconcile_only",
        capabilities: { scheduledReconcile: false, eventDrivenIngress: false, unattended: false },
        evidenceCodes: [
          "systemd_timer_failed",
          "webhook_runtime_unhealthy",
          "manual_reconcile_required",
        ],
      },
    },
  ] as const)("reports $name without claiming unattended operation", ({ sources, expected }) => {
    expect(evaluateRegistrationWakeupHealth(sources)).toEqual({
      ...expected,
      sources: {
        systemd: {
          state: sourceState(sources.systemd, "active"),
          evidenceCode: expected.evidenceCodes[0],
        },
        webhook: {
          state: sourceState(sources.webhook, "verified"),
          evidenceCode: expected.evidenceCodes[1],
        },
      },
    });
  });

  it("treats malformed or arbitrary evidence as unknown and never reflects it", () => {
    const marker = "systemctl --user enable compromised.timer";
    const health = evaluateRegistrationWakeupHealth({
      systemd: "active",
      webhook: "verified",
      displayText: marker,
    });

    expect(health).toEqual({
      state: "degraded",
      mode: "manual_reconcile_only",
      capabilities: { scheduledReconcile: false, eventDrivenIngress: false, unattended: false },
      sources: {
        systemd: { state: "unknown", evidenceCode: "systemd_status_unknown" },
        webhook: { state: "unknown", evidenceCode: "webhook_runtime_unknown" },
      },
      evidenceCodes: [
        "systemd_status_unknown",
        "webhook_runtime_unknown",
        "manual_reconcile_required",
      ],
    });
    expect(JSON.stringify(health)).not.toContain(marker);
  });

  it("does not treat an installed-looking or inactive timer as an active wake-up source", () => {
    expect(
      evaluateRegistrationWakeupHealth({ systemd: "installed", webhook: "verified" }),
    ).toMatchObject({
      state: "degraded",
      mode: "event_ingest_only",
      capabilities: { scheduledReconcile: false, eventDrivenIngress: true, unattended: false },
      sources: {
        systemd: { state: "unknown", evidenceCode: "systemd_status_unknown" },
        webhook: { state: "available", evidenceCode: "webhook_runtime_verified" },
      },
    });
    expect(
      evaluateRegistrationWakeupHealth({ systemd: "inactive", webhook: "verified" }),
    ).toMatchObject({
      state: "degraded",
      mode: "event_ingest_only",
      capabilities: { scheduledReconcile: false, eventDrivenIngress: true, unattended: false },
      sources: {
        systemd: { state: "unavailable", evidenceCode: "systemd_timer_inactive" },
        webhook: { state: "available", evidenceCode: "webhook_runtime_verified" },
      },
    });
  });
});
