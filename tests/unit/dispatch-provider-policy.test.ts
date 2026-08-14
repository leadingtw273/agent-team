import { describe, expect, it, vi } from "vitest";

import type { ProviderPort, ProviderRunRequest } from "../../src/application/ports/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { PolicyBoundProvider } from "../../src/cli/dispatch/provider-policy.js";

function request(role: ProviderRunRequest["role"], model: string): ProviderRunRequest {
  return { role, model } as ProviderRunRequest;
}

function delegate(provider = "codex", models: readonly string[] = ["gpt-5.6-terra"]) {
  const start = vi.fn<ProviderPort["start"]>(() =>
    Promise.resolve(err(domainError("unavailable"))),
  );
  const port: ProviderPort = {
    inspectCapabilities: () =>
      Promise.resolve(
        ok({
          provider,
          cliVersion: "test",
          models,
          supportsResume: false,
          supportsStructuredEvents: true,
          supportsDynamicApproval: true,
          supportsVisualInput: false,
        }),
      ),
    start,
  };
  return { port, start };
}

describe("PolicyBoundProvider", () => {
  it("prevents a Codex execution provider from starting a code-review role", async () => {
    const fake = delegate();
    const provider = new PolicyBoundProvider({
      delegate: fake.port,
      provider: "codex",
      models: ["gpt-5.6-terra"],
      roles: ["team_lead", "implementer", "integration_engineer"],
    });

    const denied = await provider.start(request("code_reviewer", "gpt-5.6-terra"));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("permission_denied");
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("prevents a configured provider from receiving another provider's model", async () => {
    const fake = delegate();
    const provider = new PolicyBoundProvider({
      delegate: fake.port,
      provider: "codex",
      models: ["gpt-5.6-terra"],
      roles: ["implementer"],
    });

    const denied = await provider.start(request("implementer", "claude-opus"));
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("invariant_violation");
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("fails capability inspection closed when the delegate reports a different provider", async () => {
    const fake = delegate("claude", ["gpt-5.6-terra"]);
    const provider = new PolicyBoundProvider({
      delegate: fake.port,
      provider: "codex",
      models: ["gpt-5.6-terra"],
      roles: ["implementer"],
    });

    const inspected = await provider.inspectCapabilities();
    expect(inspected.ok).toBe(false);
    if (!inspected.ok) expect(inspected.error.code).toBe("invariant_violation");
  });
});
