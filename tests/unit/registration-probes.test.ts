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
  provenance: RegistrationReadOnlyGateObservation["provenance"] = "fixture",
): RegistrationReadOnlyGateObservation {
  return Object.freeze({
    state,
    evidence: Object.freeze([...evidence]),
    provenance,
    observedAt: "2026-08-05T12:00:00.000Z",
  });
}

const readOnlyProvenance = Object.freeze({
  local_repository: "local_git",
  node_runtime: "node_runtime",
  agent_cli: "compiled_cli",
  github_access: "github_read_only",
  linear_access: "linear_read_only",
  continuous_integration: "ci_read_only",
  webhook_runtime: "webhook_configuration",
} as const satisfies Readonly<
  Record<O002GateId, RegistrationReadOnlyGateObservation["provenance"]>
>);

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
        return ok(
          observation("passed", [`Authorization: Bearer ${marker}`], readOnlyProvenance[gate]),
        );
      }
      if (gate === "linear_access") return err(domainError("unavailable"));
      return ok(observation("passed", [`safe evidence for ${gate}`], readOnlyProvenance[gate]));
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
      return ok(observation("passed", [`safe evidence for ${gate}`], readOnlyProvenance[gate]));
    });

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source: "read_only" }).scan();
    const github = scan.gates.find((gate) => gate.id === "github_access");
    const linear = scan.gates.find((gate) => gate.id === "linear_access");

    expect(github).toMatchObject({ state: "unknown", error: "unknown" });
    expect(linear).toMatchObject({ state: "unknown", error: "invalid_evidence" });
    expect(JSON.stringify(scan)).not.toContain("raw adapter diagnostic");
  });

  it.each([
    "gh repo view",
    "curl https://example.test",
    "git status",
    "systemctl status agent-team",
    "node --version",
    "pnpm test",
    "npm run build",
    "codex exec review",
    "claude -p review",
    "gemini inspect",
  ])("rejects complete command evidence: %s", async (command) => {
    const ports = probePorts((gate) =>
      ok(
        observation("passed", [`read-only evidence includes ${command}`], readOnlyProvenance[gate]),
      ),
    );

    const scan = await createRegistrationReadOnlyScanUseCase({
      ports,
      source: "read_only",
    }).scan();

    expect(scan.gates.find((gate) => gate.id === "local_repository")).toMatchObject({
      state: "unknown",
      provenance: "not_scanned",
      error: "invalid_evidence",
    });
    expect(JSON.stringify(scan)).not.toContain(command);
  });

  it.each([
    { source: "fixture" as const, provenance: "local_git" as const },
    { source: "read_only" as const, provenance: "fixture" as const },
    { source: "read_only" as const, provenance: "github_read_only" as const },
  ])("rejects provenance $provenance for $source local gate", async ({ source, provenance }) => {
    const ports = probePorts((gate) =>
      ok(observation("passed", [`safe evidence for ${gate}`], provenance)),
    );

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source }).scan();

    expect(scan.gates.find((gate) => gate.id === "local_repository")).toMatchObject({
      state: "unknown",
      provenance: "not_scanned",
      error: "invalid_evidence",
    });
  });
});
