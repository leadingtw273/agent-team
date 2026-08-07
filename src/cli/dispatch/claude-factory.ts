/**
 * C015b item 3: builds a production-wired `ClaudeRunner` (src/adapters/providers/claude/runner.ts)
 * from host provider config -- the real `ProcessPort` (R001's `ChildProcessRunner`, bounded child
 * process, src/adapters/process/runner.ts) and the real F012 secret redactor
 * (src/infrastructure/redaction/redactor.ts), never fakes. `ClaudeRunner` itself is untouched;
 * this is pure composition, no engine/adapter modification.
 */
import { ChildProcessRunner } from "../../adapters/process/index.js";
import { ClaudeRunner } from "../../adapters/providers/claude/index.js";
import { Redactor } from "../../infrastructure/redaction/index.js";
import type { DispatchProviderConfig } from "./provider-config-store.js";

export function buildClaudeRunner(config: DispatchProviderConfig["claude"]): ClaudeRunner {
  return new ClaudeRunner({
    process: new ChildProcessRunner(),
    redactor: new Redactor(),
    executable: config.executable,
    models: config.models,
  });
}
