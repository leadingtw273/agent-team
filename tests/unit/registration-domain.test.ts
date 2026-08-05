import { readFile } from "node:fs/promises";

import { Ajv2020, type AnySchema } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import { domainError } from "../../src/domain/foundation/index.js";
import {
  evaluateRegistrationGates,
  initialRegistrationState,
  parseRegistrationStateSnapshot,
  registrationCapabilities,
  registrationDegradationReasons,
  registrationGateIds,
  registrationGateStates,
  registrationStateLabels,
  registrationStateSnapshotJsonSchema,
  registrationStateSnapshotSchema,
  registrationStates,
  transitionRegistrationState,
  type RegistrationGateSnapshot,
  type RegistrationGateState,
  type RegistrationGateRecord,
  type RegistrationState,
  type RegistrationStateSnapshot,
  type RegistrationTransitionRequest,
} from "../../src/application/registration/index.js";

function gateSnapshot(state: RegistrationGateState = "passed"): RegistrationGateSnapshot {
  return Object.freeze(
    Object.fromEntries(registrationGateIds.map((gate) => [gate, state])) as Record<
      (typeof registrationGateIds)[number],
      RegistrationGateState
    >,
  );
}

function gateRecord(state: RegistrationGateState = "passed"): RegistrationGateRecord {
  return Object.freeze(
    Object.fromEntries(registrationGateIds.map((gate) => [gate, state])) as Record<
      (typeof registrationGateIds)[number],
      RegistrationGateState
    >,
  );
}

function persistedSnapshot(
  overrides: Partial<RegistrationStateSnapshot> = {},
): RegistrationStateSnapshot {
  return Object.freeze({
    schemaVersion: 1,
    state: "configuration_incomplete",
    gates: gateRecord(),
    ...overrides,
  });
}

async function readJson(relativePath: string): Promise<unknown> {
  return JSON.parse(
    await readFile(new URL(`../../${relativePath}`, import.meta.url), "utf8"),
  ) as unknown;
}

function withGateState(
  gate: (typeof registrationGateIds)[number],
  state: RegistrationGateState,
): RegistrationGateSnapshot {
  return Object.freeze({ ...gateSnapshot(), [gate]: state });
}

function withoutGate(gate: (typeof registrationGateIds)[number]): RegistrationGateSnapshot {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(gateSnapshot()).filter(([candidate]) => candidate !== gate),
    ) as RegistrationGateSnapshot,
  );
}

const allGatesPassed = gateSnapshot();
const oneGateFailed = withGateState("webhook_runtime", "failed");

describe("registration domain", () => {
  it("keeps the four approved health states and their Chinese labels closed", () => {
    expect(registrationStates).toEqual([
      "configuration_incomplete",
      "registered",
      "degraded",
      "disabled",
    ]);
    expect(registrationStateLabels).toEqual({
      configuration_incomplete: "設定未完成",
      registered: "已註冊",
      degraded: "降級",
      disabled: "已停用",
    });
    expect(initialRegistrationState).toBe("configuration_incomplete");
  });

  it("requires the complete Registration Gate catalog to pass before it reports ready", () => {
    expect(registrationGateIds).toEqual([
      "local_repository",
      "node_runtime",
      "agent_cli",
      "trusted_project_config",
      "linear_access",
      "github_access",
      "continuous_integration",
      "github_review_status",
      "github_auto_merge",
      "webhook_runtime",
      "reconcile_wakeup",
    ]);
    expect(evaluateRegistrationGates(allGatesPassed)).toEqual({ complete: true, blockers: [] });
    expect(registrationGateStates).toEqual(["passed", "failed", "unknown"]);
    expect(registrationDegradationReasons).toEqual([
      "adapter_failure",
      "webhook_unavailable",
      "quota_monitor_unavailable",
      "reconcile_wakeup_unavailable",
    ]);
  });

  it("property: every missing, failed, or unknown required Gate blocks registration", () => {
    for (const gate of registrationGateIds) {
      for (const state of ["failed", "unknown"] as const) {
        expect(evaluateRegistrationGates(withGateState(gate, state))).toEqual({
          complete: false,
          blockers: [{ gate, state }],
        });
      }
      expect(evaluateRegistrationGates(withoutGate(gate))).toEqual({
        complete: false,
        blockers: [{ gate, state: "missing" }],
      });
    }
  });

  it("reports every missing Gate in stable catalog order", () => {
    expect(evaluateRegistrationGates({})).toEqual({
      complete: false,
      blockers: registrationGateIds.map((gate) => ({ gate, state: "missing" })),
    });
  });

  it("round-trips a versioned persisted Registration snapshot and its JSON Schema", async () => {
    const snapshot = persistedSnapshot({ state: "disabled" });
    const roundTripped = JSON.parse(JSON.stringify(snapshot)) as unknown;

    expect(parseRegistrationStateSnapshot(roundTripped)).toEqual({ ok: true, value: snapshot });
    expect(registrationStateSnapshotSchema.parse(roundTripped)).toEqual(snapshot);
    await expect(readJson("schemas/registration-state-v1.json")).resolves.toEqual(
      registrationStateSnapshotJsonSchema,
    );
  });

  it("enforces the registered Gate invariant with the published Draft 2020-12 schema", async () => {
    const publishedSchema = (await readJson("schemas/registration-state-v1.json")) as AnySchema;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(publishedSchema);
    const registeredWithAllGatesPassed = persistedSnapshot({ state: "registered" });
    const degradedWithFailedGate = {
      ...registeredWithAllGatesPassed,
      state: "degraded",
      gates: { ...registeredWithAllGatesPassed.gates, webhook_runtime: "failed" },
    };

    for (const [snapshot, accepted] of [
      [registeredWithAllGatesPassed, true],
      [degradedWithFailedGate, true],
    ] as const) {
      expect(validate(snapshot)).toBe(accepted);
      expect(registrationStateSnapshotSchema.safeParse(snapshot).success).toBe(accepted);
    }

    for (const gate of registrationGateIds) {
      for (const gateState of ["failed", "unknown"] as const) {
        const registeredWithUnpassedGate = {
          ...registeredWithAllGatesPassed,
          gates: { ...registeredWithAllGatesPassed.gates, [gate]: gateState },
        };
        expect(validate(registeredWithUnpassedGate)).toBe(false);
        expect(registrationStateSnapshotSchema.safeParse(registeredWithUnpassedGate).success).toBe(
          false,
        );
      }
    }
  });

  it("rejects corrupted persisted Registration state rather than normalizing it", () => {
    const snapshot = persistedSnapshot({ state: "registered" });
    const gatesWithoutWebhook = Object.fromEntries(
      Object.entries(snapshot.gates).filter(([gate]) => gate !== "webhook_runtime"),
    );
    const invalidSnapshots: readonly unknown[] = [
      { ...snapshot, schemaVersion: 2 },
      { ...snapshot, state: "retired" },
      { ...snapshot, gates: { ...snapshot.gates, webhook_runtime: "failed" } },
      { ...snapshot, untrusted: true },
      { schemaVersion: 1, state: "registered" },
      { ...snapshot, gates: { ...snapshot.gates, webhook_runtime: "not_a_gate_state" } },
      { ...snapshot, gates: { ...snapshot.gates, untrusted: "passed" } },
      { ...snapshot, gates: gatesWithoutWebhook },
    ];

    for (const candidate of invalidSnapshots) {
      expect(parseRegistrationStateSnapshot(candidate)).toEqual({
        ok: false,
        error: domainError("invariant_violation"),
      });
    }
  });

  it.each([
    [
      "configuration_incomplete",
      { cause: "revalidation_succeeded", gates: allGatesPassed },
      "registered",
    ],
    ["registered", { cause: "revalidation_succeeded", gates: allGatesPassed }, "registered"],
    ["degraded", { cause: "revalidation_succeeded", gates: allGatesPassed }, "registered"],
    [
      "configuration_incomplete",
      { cause: "revalidation_failed", gates: oneGateFailed },
      "configuration_incomplete",
    ],
    [
      "registered",
      { cause: "revalidation_failed", gates: oneGateFailed },
      "configuration_incomplete",
    ],
    [
      "degraded",
      { cause: "revalidation_failed", gates: oneGateFailed },
      "configuration_incomplete",
    ],
    ["registered", { cause: "operational_degradation", reason: "webhook_unavailable" }, "degraded"],
    [
      "degraded",
      { cause: "operational_degradation", reason: "quota_monitor_unavailable" },
      "degraded",
    ],
    [
      "configuration_incomplete",
      { cause: "operational_degradation", reason: "adapter_failure" },
      "configuration_incomplete",
    ],
    ["configuration_incomplete", { cause: "user_disabled" }, "disabled"],
    ["registered", { cause: "user_disabled" }, "disabled"],
    ["degraded", { cause: "user_disabled" }, "disabled"],
    ["disabled", { cause: "user_enabled" }, "configuration_incomplete"],
  ] as const satisfies readonly [
    RegistrationState,
    RegistrationTransitionRequest,
    RegistrationState,
  ][])("allows %s with %o to become %s", (current, request, target) => {
    expect(transitionRegistrationState(current, request)).toEqual({ ok: true, value: target });
  });

  it("rejects a declared successful Revalidation unless every Gate passed", () => {
    expect(
      transitionRegistrationState("configuration_incomplete", {
        cause: "revalidation_succeeded",
        gates: oneGateFailed,
      }),
    ).toEqual({ ok: false, error: domainError("conflict") });
  });

  it("rejects a declared failed Revalidation when all Gates actually passed", () => {
    expect(
      transitionRegistrationState("registered", {
        cause: "revalidation_failed",
        gates: allGatesPassed,
      }),
    ).toEqual({ ok: false, error: domainError("conflict") });
  });

  it("requires the explicit disabled → enable → Revalidate sequence", () => {
    expect(transitionRegistrationState("registered", { cause: "user_enabled" })).toEqual({
      ok: false,
      error: domainError("conflict"),
    });
    expect(transitionRegistrationState("disabled", { cause: "user_enabled" })).toEqual({
      ok: true,
      value: "configuration_incomplete",
    });
    expect(
      transitionRegistrationState("configuration_incomplete", {
        cause: "revalidation_succeeded",
        gates: allGatesPassed,
      }),
    ).toEqual({ ok: true, value: "registered" });
  });

  it("property: no automatic event can recover a disabled project", () => {
    const automaticRequests: readonly RegistrationTransitionRequest[] = [
      { cause: "revalidation_succeeded", gates: allGatesPassed },
      { cause: "revalidation_failed", gates: oneGateFailed },
      { cause: "operational_degradation", reason: "adapter_failure" },
      { cause: "operational_degradation", reason: "webhook_unavailable" },
      { cause: "operational_degradation", reason: "quota_monitor_unavailable" },
      { cause: "operational_degradation", reason: "reconcile_wakeup_unavailable" },
    ];

    for (const request of automaticRequests) {
      expect(transitionRegistrationState("disabled", request)).toEqual({
        ok: true,
        value: "disabled",
      });
    }
  });

  it("fails closed for unrecognized runtime state, Gate snapshots, and transition causes", () => {
    const safeCapabilities = {
      automaticDispatch: false,
      automaticAutoMerge: false,
      runningWorkCheckpoint: "required",
    } as const;
    const successfulRevalidation = {
      cause: "revalidation_succeeded",
      gates: allGatesPassed,
    } as const;

    for (const state of ["retired", null, { state: "registered" }] as const) {
      expect(transitionRegistrationState(state, successfulRevalidation)).toEqual({
        ok: false,
        error: domainError("invariant_violation"),
      });
      expect(registrationCapabilities(state)).toEqual(safeCapabilities);
    }

    for (const request of [
      { cause: "later_auto_enable" },
      { cause: "revalidation_succeeded" },
      { cause: "operational_degradation" },
      { cause: "user_enabled", untrusted: true },
      { cause: "revalidation_succeeded", gates: { ...allGatesPassed, untrusted: "passed" } },
      { cause: "revalidation_succeeded", gates: null },
    ] as const) {
      expect(transitionRegistrationState("registered", request)).toEqual({
        ok: false,
        error: domainError("invariant_violation"),
      });
    }

    const expectedInvalidGateEvaluation = {
      complete: false,
      blockers: registrationGateIds.map((gate) => ({ gate, state: "missing" })),
    };
    expect(evaluateRegistrationGates(null)).toEqual(expectedInvalidGateEvaluation);
    expect(evaluateRegistrationGates({ ...allGatesPassed, untrusted: "passed" })).toEqual(
      expectedInvalidGateEvaluation,
    );
  });

  it.each([
    ["configuration_incomplete", false, false, "none"],
    ["registered", true, true, "none"],
    ["degraded", false, false, "when_safe"],
    ["disabled", false, false, "required"],
  ] as const satisfies readonly [
    RegistrationState,
    boolean,
    boolean,
    "none" | "when_safe" | "required",
  ][])(
    "%s exposes the correct dispatch, Auto-merge, and Checkpoint Gate",
    (state, automaticDispatch, automaticAutoMerge, runningWorkCheckpoint) => {
      expect(registrationCapabilities(state)).toEqual({
        automaticDispatch,
        automaticAutoMerge,
        runningWorkCheckpoint,
      });
    },
  );
});
