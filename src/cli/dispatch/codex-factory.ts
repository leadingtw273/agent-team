import { ChildProcessRunner } from "../../adapters/process/index.js";
import { CodexRunner } from "../../adapters/providers/codex/index.js";
import { Redactor } from "../../infrastructure/redaction/index.js";
import type { ProviderPort } from "../../application/ports/index.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";
import { PolicyBoundProvider } from "./provider-policy.js";

/** Production Codex execution runner. Role-level read/write boundaries remain enforced by
 * CodexRunner's request role and the existing tool-decision/protected-region gates. */
export function buildCodexRunner(config: DispatchProviderConfig["codex"]): ProviderPort {
  const runner = new CodexRunner({
    process: new ChildProcessRunner(),
    redactor: new Redactor(),
    executable: config.executable,
    models: config.models,
  });
  return new PolicyBoundProvider({
    delegate: runner,
    provider: "codex",
    models: config.models,
    roles: ["team_lead", "implementer", "integration_engineer"],
  });
}
