import { describe, expect, it } from "vitest";

import {
  createRegistrationReadOnlyScanUseCase,
  registrationGateIds,
} from "../../src/application/registration/index.js";
import type { RegistrationReadOnlyScanPorts } from "../../src/application/ports/index.js";
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

type ProbeResult = Result<unknown, DomainError>;

const observedAt = "2026-08-05T12:00:00.000Z";

function validObservation(gate: O002GateId): Readonly<Record<string, unknown>> {
  switch (gate) {
    case "local_repository":
      return { evidenceCode: "local_repository_clean", observedAt };
    case "node_runtime":
      return {
        evidenceCode: "node_runtime_detected",
        detectedMajor: 24,
        requiredMajor: 24,
        observedAt,
      };
    case "agent_cli":
      return { evidenceCode: "compiled_cli_version_verified", version: "0.1.0", observedAt };
    case "github_access":
      return { evidenceCode: "github_repository_readable", observedAt };
    case "linear_access":
      return { evidenceCode: "linear_context_verified", observedAt };
    case "continuous_integration":
      return { evidenceCode: "ci_run_succeeded", observedAt };
    case "webhook_runtime":
      return { evidenceCode: "webhook_url_format_verified", observedAt };
  }
}

function probePorts(inspect: (gate: O002GateId) => ProbeResult): RegistrationReadOnlyScanPorts {
  const ports = {
    localRepository: { inspect: () => Promise.resolve(inspect("local_repository")) },
    nodeRuntime: { inspect: () => Promise.resolve(inspect("node_runtime")) },
    compiledCli: { inspect: () => Promise.resolve(inspect("agent_cli")) },
    github: { inspect: () => Promise.resolve(inspect("github_access")) },
    linear: { inspect: () => Promise.resolve(inspect("linear_access")) },
    continuousIntegration: {
      inspect: () => Promise.resolve(inspect("continuous_integration")),
    },
    webhookRuntime: { inspect: () => Promise.resolve(inspect("webhook_runtime")) },
  };
  return ports as unknown as RegistrationReadOnlyScanPorts;
}

describe("O002 registration typed read-only evidence", () => {
  it("derives concrete evidence, state, repair, and gate-bound provenance for all seven probes", async () => {
    const ports = probePorts((gate) => ok(validObservation(gate)));

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source: "fixture" }).scan();

    expect(scan.source).toBe("fixture");
    expect(scan.state).toBe("configuration_incomplete");
    expect(scan.gates.map((gate) => gate.id)).toEqual(registrationGateIds);
    const scanned = scan.gates.filter((gate) => gate.scope === "O002 Read-only scan");
    expect(scanned).toHaveLength(7);
    expect(scanned.map((gate) => gate.state)).toEqual([
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "passed",
      "unknown",
    ]);
    expect(scanned.map((gate) => gate.provenance)).toEqual([
      "local_git",
      "node_runtime",
      "compiled_cli",
      "linear_read_only",
      "github_read_only",
      "ci_read_only",
      "webhook_configuration",
    ]);
    for (const gate of scanned) {
      expect(gate.evidence[0]?.length).toBeGreaterThan(12);
      expect(gate.repair.length).toBeGreaterThan(12);
      expect(gate.error).toBeUndefined();
    }
    expect(scan.gates.find((gate) => gate.id === "github_auto_merge")).toMatchObject({
      state: "unknown",
      provenance: "not_scanned",
      error: "not_scanned",
    });
    expect(scan.complete).toBe(false);
  });

  it("maps port errors to fixed summaries without reflecting raw remote diagnostics", async () => {
    const marker = "remote raw /usr/bin/pwsh -Command Invoke-WebRequest";
    const ports = probePorts((gate) => {
      if (gate === "github_access") {
        return err({ ...domainError("permission_denied"), rawMessage: marker } as DomainError);
      }
      return ok(validObservation(gate));
    });

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source: "read_only" }).scan();
    const github = scan.gates.find((gate) => gate.id === "github_access");

    expect(github).toMatchObject({
      state: "unknown",
      provenance: "github_read_only",
      error: "permission_denied",
    });
    expect(github?.evidence).toEqual(["目前權限不足以確認此 Gate；未顯示原始診斷內容。"]);
    expect(JSON.stringify(scan)).not.toContain(marker);
  });

  it.each([
    "gh repo view",
    "curl https://example.test",
    "git status",
    "systemctl status agent-team",
    "node --version",
    "pnpm test",
    "codex exec review",
    "claude -p review",
    "gemini inspect",
    "bash -lc whoami",
    "sh -c id",
    "powershell -Command Get-ChildItem",
    "pwsh -File C:\\temp\\probe.ps1",
    "/usr/bin/env bash -lc pwd",
    "/bin/git status",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command Get-Item",
    "/home/leadi/private/tool --dump",
  ])(
    "rejects arbitrary displayText even when it contains an unlisted command or path: %s",
    async (text) => {
      const ports = probePorts((gate) => ok({ ...validObservation(gate), displayText: text }));

      const scan = await createRegistrationReadOnlyScanUseCase({
        ports,
        source: "read_only",
      }).scan();

      expect(scan.gates.filter((gate) => gate.scope === "O002 Read-only scan")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ state: "unknown", error: "invalid_evidence" }),
        ]),
      );
      expect(
        scan.gates
          .filter((gate) => gate.scope === "O002 Read-only scan")
          .every((gate) => gate.error === "invalid_evidence"),
      ).toBe(true);
      expect(JSON.stringify(scan)).not.toContain(text);
    },
  );

  it.each([
    { name: "unknown code", override: { evidenceCode: "local_repository_magic" } },
    { name: "wrong-gate code", override: { evidenceCode: "github_repository_readable" } },
    { name: "legacy evidence", override: { evidence: ["apparently safe"] } },
    { name: "legacy repair", override: { repair: "apparently safe" } },
    { name: "legacy provenance", override: { provenance: "local_git" } },
    { name: "legacy source", override: { source: "read_only" } },
    { name: "absolute path", override: { repositoryPath: "/home/leadi/private" } },
  ])("fails the entire Gate closed for $name", async ({ override }) => {
    const ports = probePorts((gate) =>
      ok(
        gate === "local_repository"
          ? { ...validObservation(gate), ...override }
          : validObservation(gate),
      ),
    );

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source: "read_only" }).scan();

    expect(scan.gates.find((gate) => gate.id === "local_repository")).toMatchObject({
      state: "unknown",
      provenance: "local_git",
      error: "invalid_evidence",
    });
  });

  it.each([
    { gate: "node_runtime" as const, override: { detectedMajor: "24" } },
    { gate: "node_runtime" as const, override: { requiredMajor: 100 } },
    { gate: "agent_cli" as const, override: { version: "/bin/bash -lc whoami" } },
    { gate: "agent_cli" as const, override: { version: "prefix 0.1.0 suffix" } },
  ])("rejects malformed typed values for $gate", async ({ gate: target, override }) => {
    const ports = probePorts((gate) =>
      ok(gate === target ? { ...validObservation(gate), ...override } : validObservation(gate)),
    );

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source: "read_only" }).scan();

    expect(scan.gates.find((gate) => gate.id === target)).toMatchObject({
      state: "unknown",
      error: "invalid_evidence",
    });
  });

  it("fails closed when a port throws or omits its timestamp", async () => {
    const ports = probePorts((gate) => {
      if (gate === "github_access") throw new Error("raw adapter diagnostic");
      if (gate === "linear_access") return ok({ evidenceCode: "linear_context_verified" });
      return ok(validObservation(gate));
    });

    const scan = await createRegistrationReadOnlyScanUseCase({ ports, source: "read_only" }).scan();

    expect(scan.gates.find((gate) => gate.id === "github_access")).toMatchObject({
      state: "unknown",
      error: "unknown",
    });
    expect(scan.gates.find((gate) => gate.id === "linear_access")).toMatchObject({
      state: "unknown",
      error: "invalid_evidence",
    });
    expect(JSON.stringify(scan)).not.toContain("raw adapter diagnostic");
  });
});
