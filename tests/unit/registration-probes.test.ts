import { describe, expect, it } from "vitest";

import {
  createRegistrationReadOnlyScanUseCase,
  registrationGateIds,
  type RegistrationGateState,
} from "../../src/application/registration/index.js";
import type {
  RegistrationReadOnlyGateObservation,
  RegistrationReadOnlyScanPorts,
} from "../../src/application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../src/domain/foundation/index.js";

type O002GateId =
  | "local_repository"
  | "node_runtime"
  | "agent_cli"
  | "github_access"
  | "linear_access"
  | "continuous_integration"
  | "webhook_runtime";

type ProbeResult = Result<RegistrationReadOnlyGateObservation, DomainError>;

function observation(
  state: RegistrationGateState,
  evidence: readonly string[],
): RegistrationReadOnlyGateObservation {
  return Object.freeze({
    state,
    evidence: Object.freeze([...evidence]),
    provenance: "fixture",
    observedAt: "2026-08-05T12:00:00.000Z",
  });
}

function probePorts(inspect: (gate: O002GateId) => ProbeResult): RegistrationReadOnlyScanPorts {
  return Object.freeze({
    localRepository: Object.freeze({
      inspect: () => Promise.resolve(inspect("local_repository")),
    }),
    nodeRuntime: Object.freeze({ inspect: () => Promise.resolve(inspect("node_runtime")) }),
    compiledCli: Object.freeze({ inspect: () => Promise.resolve(inspect("agent_cli")) }),
    github: Object.freeze({ inspect: () => Promise.resolve(inspect("github_access")) }),
    linear: Object.freeze({ inspect: () => Promise.resolve(inspect("linear_access")) }),
    continuousIntegration: Object.freeze({
      inspect: () => Promise.resolve(inspect("continuous_integration")),
    }),
    webhookRuntime: Object.freeze({ inspect: () => Promise.resolve(inspect("webhook_runtime")) }),
  });
}

describe("O002 registration read-only probes", () => {
  it("scans seven O002 ports while listing every O001 Gate and never turns a scan into registration", async () => {
    const ports = probePorts((gate) =>
      ok(
        observation(gate === "continuous_integration" ? "failed" : "passed", [
          `fixture evidence for ${gate}`,
        ]),
      ),
    );

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source: "fixture" }).scan();

    expect(scan.source).toBe("fixture");
    expect(scan.state).toBe("configuration_incomplete");
    expect(scan.gates.map((gate) => gate.id)).toEqual(registrationGateIds);
    const continuousIntegration = scan.gates.find((gate) => gate.id === "continuous_integration");
    const autoMerge = scan.gates.find((gate) => gate.id === "github_auto_merge");
    expect(continuousIntegration?.state).toBe("failed");
    expect(continuousIntegration?.repair).toContain("GitHub Actions");
    expect(autoMerge?.scope).toBe("後續 Gate");
    expect(scan.complete).toBe(false);
  });

  it("fails closed when a probe is unavailable or supplies unsafe evidence", async () => {
    const marker = ["github", "_pat_", "abcdefghijklmnopqrstuvwxyz"].join("");
    const ports = probePorts((gate) => {
      if (gate === "github_access") {
        return ok(observation("passed", [`Authorization: Bearer ${marker}`]));
      }
      if (gate === "linear_access") return err(domainError("unavailable"));
      return ok(observation("passed", [`safe evidence for ${gate}`]));
    });

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source: "read_only" }).scan();
    const github = scan.gates.find((gate) => gate.id === "github_access");
    const linear = scan.gates.find((gate) => gate.id === "linear_access");

    expect(github).toMatchObject({ state: "unknown" });
    expect(linear).toMatchObject({ state: "unknown" });
    expect(JSON.stringify(scan)).not.toContain(marker);
    expect(JSON.stringify(scan)).not.toContain("Authorization");
  });

  it("fails closed when a port throws or omits required provenance and timestamp", async () => {
    const ports = probePorts((gate) => {
      if (gate === "github_access") throw new Error("raw adapter diagnostic");
      if (gate === "linear_access") {
        return ok({
          state: "passed",
          evidence: Object.freeze(["apparently safe but incomplete observation"]),
          provenance: "fixture",
        } as unknown as RegistrationReadOnlyGateObservation);
      }
      return ok(observation("passed", [`safe evidence for ${gate}`]));
    });

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source: "read_only" }).scan();
    const github = scan.gates.find((gate) => gate.id === "github_access");
    const linear = scan.gates.find((gate) => gate.id === "linear_access");

    expect(github).toMatchObject({ state: "unknown", error: "unknown" });
    expect(linear).toMatchObject({ state: "unknown", error: "invalid_evidence" });
    expect(JSON.stringify(scan)).not.toContain("raw adapter diagnostic");
  });
});
