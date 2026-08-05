import {
  createRegistrationReadOnlyScanUseCase,
  type RegistrationReadOnlyScanUseCase,
} from "../../../application/registration/index.js";
import type { RegistrationReadOnlyScanPorts } from "../../../application/ports/index.js";
import { ok } from "../../../domain/foundation/index.js";

const observedAt = "2026-08-05T12:00:00.000Z";

/**
 * Browser and visual tests use only this synthetic port set. It still goes
 * through the same O002 coordinator used by real read-only composition.
 */
export const fixtureRegistrationReadOnlyScanPorts: RegistrationReadOnlyScanPorts = Object.freeze({
  localRepository: Object.freeze({
    inspect: () =>
      Promise.resolve(ok({ evidenceCode: "local_repository_clean", observedAt } as const)),
  }),
  nodeRuntime: Object.freeze({
    inspect: () =>
      Promise.resolve(
        ok({
          evidenceCode: "node_runtime_detected",
          detectedMajor: 24,
          requiredMajor: 24,
          observedAt,
        } as const),
      ),
  }),
  compiledCli: Object.freeze({
    inspect: () =>
      Promise.resolve(
        ok({
          evidenceCode: "compiled_cli_version_verified",
          version: "0.1.0",
          observedAt,
        } as const),
      ),
  }),
  github: Object.freeze({
    inspect: () =>
      Promise.resolve(ok({ evidenceCode: "github_target_unconfigured", observedAt } as const)),
  }),
  linear: Object.freeze({
    inspect: () =>
      Promise.resolve(ok({ evidenceCode: "linear_target_unconfigured", observedAt } as const)),
  }),
  continuousIntegration: Object.freeze({
    inspect: () =>
      Promise.resolve(ok({ evidenceCode: "ci_no_active_workflow", observedAt } as const)),
  }),
  webhookRuntime: Object.freeze({
    inspect: () =>
      Promise.resolve(ok({ evidenceCode: "webhook_url_unconfigured", observedAt } as const)),
  }),
});

export const fixtureRegistrationReadOnlyScanUseCase: RegistrationReadOnlyScanUseCase =
  createRegistrationReadOnlyScanUseCase({
    ports: fixtureRegistrationReadOnlyScanPorts,
    source: "fixture",
  });
