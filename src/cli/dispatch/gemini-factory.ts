/**
 * E102-2: builds a production-wired `GeminiRunner` (src/adapters/providers/gemini/runner.ts)
 * from host provider config -- mirrors `claude-factory.ts` exactly (same real `ProcessPort`,
 * R001's `ChildProcessRunner`, and the same real F012 secret redactor,
 * src/infrastructure/redaction/redactor.ts; never fakes). `GeminiRunner` itself is untouched;
 * this is pure composition, no engine/adapter modification.
 *
 * Only ever called with a schema-validated `GeminiProviderConfig` (provider-config-store.ts),
 * which already guarantees `adminPolicyPath` is an absolute path -- `GeminiRunner.start()`'s own
 * `isAbsolute` check is therefore a defence-in-depth belt, not this factory's job to duplicate.
 */
import { ChildProcessRunner } from "../../adapters/process/index.js";
import { GeminiRunner } from "../../adapters/providers/gemini/index.js";
import { Redactor } from "../../infrastructure/redaction/index.js";
import type { ProviderPort } from "../../application/ports/index.js";
import type { GeminiProviderConfig } from "./provider-config-store.js";
import { PolicyBoundProvider } from "./provider-policy.js";
import {
  defaultModelExecutionLimiter,
  LimitedProvider,
  type ModelExecutionLimiter,
} from "./provider-limiter.js";

export function buildGeminiRunner(
  config: GeminiProviderConfig,
  limiter: ModelExecutionLimiter = defaultModelExecutionLimiter,
): ProviderPort {
  const runner = new GeminiRunner({
    process: new ChildProcessRunner(),
    redactor: new Redactor(),
    executable: config.executable,
    models: config.models,
    adminPolicyPath: config.adminPolicyPath,
  });
  const policy = new PolicyBoundProvider({
    delegate: runner,
    provider: "gemini",
    models: config.models,
    roles: ["visual_reviewer"],
  });
  return new LimitedProvider("gemini", policy, limiter);
}
