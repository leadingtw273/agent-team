import {
  createRegistrationReadOnlyScanUseCase,
  type RegistrationReadOnlyScanUseCase,
} from "../../../application/registration/index.js";
import type {
  RegistrationReadOnlyGateObservation,
  RegistrationReadOnlyScanPorts,
} from "../../../application/ports/index.js";
import { ok } from "../../../domain/foundation/index.js";

const observedAt = "2026-08-05T12:00:00.000Z";

function observation(
  state: RegistrationReadOnlyGateObservation["state"],
  evidence: string,
): RegistrationReadOnlyGateObservation {
  return Object.freeze({
    state,
    evidence: Object.freeze([evidence]),
    provenance: "fixture",
    observedAt,
  });
}

function fixtureProbe(state: RegistrationReadOnlyGateObservation["state"], evidence: string) {
  return () => Promise.resolve(ok(observation(state, evidence)));
}

/**
 * Browser and visual tests use only this synthetic port set. It still goes
 * through the same O002 coordinator used by real read-only composition.
 */
export const fixtureRegistrationReadOnlyScanPorts: RegistrationReadOnlyScanPorts = Object.freeze({
  localRepository: Object.freeze({
    inspect: fixtureProbe("passed", "合成資料：本機 Git Repository 已確認，工作樹沒有未提交變更。"),
  }),
  nodeRuntime: Object.freeze({
    inspect: fixtureProbe("passed", "合成資料：已偵測 Node.js 24.x，符合專案要求。"),
  }),
  compiledCli: Object.freeze({
    inspect: fixtureProbe("passed", "合成資料：編譯後 CLI 的版本摘要可安全讀取。"),
  }),
  github: Object.freeze({
    inspect: fixtureProbe("unknown", "合成資料尚未設定 GitHub read-only 目標，因此未發出查詢。"),
  }),
  linear: Object.freeze({
    inspect: fixtureProbe("unknown", "合成資料尚未設定 Linear read-only 目標，因此未發出查詢。"),
  }),
  continuousIntegration: Object.freeze({
    inspect: fixtureProbe("failed", "合成資料：CI 摘要未找到可確認的 workflow。"),
  }),
  webhookRuntime: Object.freeze({
    inspect: fixtureProbe("unknown", "合成資料：Webhook Runtime URL 尚未設定。"),
  }),
});

export const fixtureRegistrationReadOnlyScanUseCase: RegistrationReadOnlyScanUseCase =
  createRegistrationReadOnlyScanUseCase({
    ports: fixtureRegistrationReadOnlyScanPorts,
    source: "fixture",
  });
