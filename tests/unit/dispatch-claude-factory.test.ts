/**
 * C015b unit test: `buildClaudeRunner` (src/cli/dispatch/claude-factory.ts) wires
 * `DispatchProviderConfig["claude"]` into a real `ClaudeRunner` with the real `ChildProcessRunner`/
 * `Redactor` -- this test only proves the config values (executable/models) actually reach the
 * constructed runner (via `inspectCapabilities()`, the one side-effect-free way to read them
 * back), not that a real Claude process can be spawned (that is out of scope for a unit test;
 * see the C015b end-to-end test for the fake-provider-driven pipeline coverage).
 */
import { describe, expect, it } from "vitest";

import { buildClaudeRunner } from "../../src/cli/dispatch/claude-factory.js";

describe("buildClaudeRunner", () => {
  it("wires the configured executable and models into the constructed ClaudeRunner", async () => {
    const runner = buildClaudeRunner({
      executable: "/usr/local/bin/claude",
      models: ["opus", "sonnet"],
      account: "default",
    });
    const capabilities = await runner.inspectCapabilities();
    expect(capabilities.ok).toBe(true);
    if (!capabilities.ok) return;
    expect(typeof capabilities.value.cliVersion).toBe("string");
    expect(capabilities.value).toMatchObject({
      provider: "claude",
      models: ["opus", "sonnet"],
      supportsResume: false,
      supportsStructuredEvents: true,
      supportsDynamicApproval: false,
      supportsVisualInput: true,
    });
  });
});
