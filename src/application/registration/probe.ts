import {
  domainError,
  err,
  parseInstant,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import { containsSensitiveValue } from "../../infrastructure/redaction/index.js";
import type {
  RegistrationProbeProvenance,
  RegistrationReadOnlyGateObservation,
  RegistrationReadOnlyScanPorts,
} from "../ports/registration.js";
import type { ReadOptions } from "../ports/common.js";
import { evaluateRegistrationGates } from "./policy.js";
import {
  registrationGateIds,
  registrationStateLabels,
  type RegistrationGateId,
  type RegistrationGateState,
  type RegistrationState,
} from "./model.js";

const registrationProbeTimeoutMs = 4_000;
const maximumEvidenceItems = 4;
const maximumEvidenceLength = 280;
const unsafeProbeTextPattern =
  /(?:authorization\s*[:=]|bearer\s+[a-z0-9._~+/=-]+|(?:api[_ -]?key|secret|token|password)\s*[:=]|-----begin|(?:^|\s)(?:(?:curl|wget|rm|bash|zsh|sh)\s+|git\s+(?:reset|clean|checkout|switch|push|commit|merge|rebase)\b|node\s+--|pnpm\s+(?:run|exec|install|add|remove|test)\b)|hidden\s+reasoning|chain\s+of\s+thought)/iu;

export const registrationReadOnlyScanGateIds = [
  "local_repository",
  "node_runtime",
  "agent_cli",
  "github_access",
  "linear_access",
  "continuous_integration",
  "webhook_runtime",
] as const satisfies readonly RegistrationGateId[];

export type RegistrationReadOnlyScanGateId = (typeof registrationReadOnlyScanGateIds)[number];
export type RegistrationScanSource = "fixture" | "read_only";
export type RegistrationScanGateScope = "O002 Read-only scan" | "後續 Gate";
export type RegistrationProbeErrorKind =
  | "invalid_evidence"
  | "interrupted"
  | "not_found"
  | "not_scanned"
  | "permission_denied"
  | "rate_limited"
  | "timeout"
  | "unavailable"
  | "unknown";

export interface RegistrationScanGate {
  readonly id: RegistrationGateId;
  readonly label: string;
  readonly scope: RegistrationScanGateScope;
  readonly state: RegistrationGateState;
  readonly evidence: readonly string[];
  readonly repair: string;
  readonly provenance: RegistrationProbeProvenance | "not_scanned";
  readonly observedAt?: string;
  readonly error?: RegistrationProbeErrorKind;
}

export interface RegistrationReadOnlyScanReadModel {
  readonly source: RegistrationScanSource;
  /** O002 observes only; it never writes a Registration state transition. */
  readonly state: RegistrationState;
  readonly stateLabel: string;
  readonly complete: boolean;
  readonly gates: readonly RegistrationScanGate[];
}

export interface RegistrationReadOnlyScanUseCase {
  readonly scan: (options?: ReadOptions) => Promise<RegistrationReadOnlyScanReadModel>;
}

export interface CreateRegistrationReadOnlyScanUseCaseOptions {
  readonly ports: RegistrationReadOnlyScanPorts;
  readonly source: RegistrationScanSource;
  readonly timeoutMs?: number;
}

interface RegistrationGateMetadata {
  readonly label: string;
  readonly scope: RegistrationScanGateScope;
  readonly repair: string;
}

const gateMetadata: Readonly<Record<RegistrationGateId, RegistrationGateMetadata>> = Object.freeze({
  local_repository: Object.freeze({
    label: "本機 Repository",
    scope: "O002 Read-only scan",
    repair: "指定一個含有效 Git 歷史的本機 Repository，確認預設分支後重新執行唯讀掃描。",
  }),
  node_runtime: Object.freeze({
    label: "Node.js Runtime",
    scope: "O002 Read-only scan",
    repair: "安裝符合專案要求的 Node.js 24.x，再重新執行唯讀掃描。",
  }),
  agent_cli: Object.freeze({
    label: "編譯後 Agent Team CLI",
    scope: "O002 Read-only scan",
    repair: "先建立編譯後 CLI，並確認 `--version` 可在本機安全執行。",
  }),
  trusted_project_config: Object.freeze({
    label: "可信專案設定",
    scope: "後續 Gate",
    repair:
      "在 O005 建立 Setup Draft PR、完成使用者核可並合併後，再從預設分支 Read-back `.agent-team/`。",
  }),
  linear_access: Object.freeze({
    label: "Linear 存取",
    scope: "O002 Read-only scan",
    repair:
      "設定目標 Linear Team／Project 的 read-only adapter 後重新掃描；O003 才會預覽或 Provision。",
  }),
  github_access: Object.freeze({
    label: "GitHub 存取",
    scope: "O002 Read-only scan",
    repair:
      "設定目標 GitHub Repository 與 read-only `gh` 存取後重新掃描；本階段不會變更 repository。",
  }),
  continuous_integration: Object.freeze({
    label: "CI",
    scope: "O002 Read-only scan",
    repair: "確認 GitHub Actions workflow 與最近一次可讀取的執行摘要；O004 才會套用 Ruleset。",
  }),
  github_review_status: Object.freeze({
    label: "GitHub Review Status",
    scope: "後續 Gate",
    repair: "在 O004 預覽並套用 `agent-team/review` 規則後，以 Head SHA Read-back 驗證。",
  }),
  github_auto_merge: Object.freeze({
    label: "GitHub Auto-merge",
    scope: "後續 Gate",
    repair: "在 O004 確認現有保護不被降低，再以 read-back 驗證 Auto-merge 能力。",
  }),
  webhook_runtime: Object.freeze({
    label: "Webhook Runtime",
    scope: "O002 Read-only scan",
    repair: "設定不含帳密、Query 或 Fragment 的 Runtime URL；主動 delivery 驗證留待 O006。",
  }),
  reconcile_wakeup: Object.freeze({
    label: "Reconcile 喚醒來源",
    scope: "後續 Gate",
    repair: "在 O007 安裝 user timer，或依 O008 明確設定手動 Reconcile 降級路徑。",
  }),
});

function isRegistrationGateState(value: unknown): value is RegistrationGateState {
  return value === "passed" || value === "failed" || value === "unknown";
}

function isProbeProvenance(value: unknown): value is RegistrationProbeProvenance {
  return (
    value === "local_git" ||
    value === "node_runtime" ||
    value === "compiled_cli" ||
    value === "github_read_only" ||
    value === "linear_read_only" ||
    value === "ci_read_only" ||
    value === "webhook_configuration" ||
    value === "fixture"
  );
}

function safeEvidence(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumEvidenceItems) {
    return undefined;
  }
  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    const normalized = item.replace(/\s+/gu, " ").trim();
    if (
      normalized.length === 0 ||
      normalized.length > maximumEvidenceLength ||
      containsSensitiveValue(normalized) ||
      unsafeProbeTextPattern.test(normalized)
    ) {
      return undefined;
    }
    unique.add(normalized);
  }
  return unique.size === 0 ? undefined : Object.freeze([...unique]);
}

function safeObservedAt(value: unknown): string | undefined {
  return typeof value === "string" && parseInstant(value).ok ? value : undefined;
}

function unknownGate(
  id: RegistrationGateId,
  provenance: RegistrationScanGate["provenance"],
  error: RegistrationProbeErrorKind,
  evidence: string,
): RegistrationScanGate {
  const metadata = gateMetadata[id];
  return Object.freeze({
    id,
    label: metadata.label,
    scope: metadata.scope,
    state: "unknown",
    evidence: Object.freeze([evidence]),
    repair: metadata.repair,
    provenance,
    error,
  });
}

function normalizedGate(id: RegistrationGateId, observation: unknown): RegistrationScanGate {
  if (typeof observation !== "object" || observation === null || Array.isArray(observation)) {
    return unknownGate(id, "not_scanned", "invalid_evidence", "Probe 回傳格式無法安全驗證。");
  }
  const candidate = observation as Readonly<Record<string, unknown>>;
  const evidence = safeEvidence(candidate["evidence"]);
  const provenance = candidate["provenance"];
  const observedAt = safeObservedAt(candidate["observedAt"]);
  if (
    !isRegistrationGateState(candidate["state"]) ||
    evidence === undefined ||
    !isProbeProvenance(provenance) ||
    observedAt === undefined
  ) {
    return unknownGate(
      id,
      isProbeProvenance(provenance) ? provenance : "not_scanned",
      "invalid_evidence",
      "Probe 證據無法安全顯示，未將此 Gate 視為通過。",
    );
  }
  const metadata = gateMetadata[id];
  return Object.freeze({
    id,
    label: metadata.label,
    scope: metadata.scope,
    state: candidate["state"],
    evidence,
    repair: metadata.repair,
    provenance,
    observedAt,
  });
}

function errorKind(error: unknown): RegistrationProbeErrorKind {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as Readonly<{ readonly code?: unknown }>).code
      : undefined;
  switch (code) {
    case "interrupted":
      return "interrupted";
    case "not_found":
      return "not_found";
    case "permission_denied":
      return "permission_denied";
    case "rate_limited":
      return "rate_limited";
    case "timeout":
      return "timeout";
    case "unavailable":
      return "unavailable";
    default:
      return "unknown";
  }
}

function errorEvidence(kind: RegistrationProbeErrorKind): string {
  switch (kind) {
    case "interrupted":
      return "Read-only probe 已中斷；未顯示原始診斷內容。";
    case "not_found":
      return "尚未找到此 Gate 所需的設定或目標；未顯示原始診斷內容。";
    case "permission_denied":
      return "目前權限不足以確認此 Gate；未顯示原始診斷內容。";
    case "rate_limited":
      return "Read-only probe 遇到服務限制，暫時無法確認。";
    case "timeout":
      return "Read-only probe 在限制時間內未完成，暫時無法確認。";
    case "unavailable":
      return "此 Gate 的 read-only adapter 或設定目前不可用。";
    default:
      return "此 Gate 無法安全確認；未顯示原始診斷內容。";
  }
}

function deferredGate(id: RegistrationGateId): RegistrationScanGate {
  const metadata = gateMetadata[id];
  return Object.freeze({
    id,
    label: metadata.label,
    scope: metadata.scope,
    state: "unknown",
    evidence: Object.freeze([
      "此 Gate 屬於後續階段；O002 不會建立設定、修改外部服務或宣稱已驗證。",
    ]),
    repair: metadata.repair,
    provenance: "not_scanned",
    error: "not_scanned",
  });
}

function invokeProbe(
  id: RegistrationReadOnlyScanGateId,
  ports: RegistrationReadOnlyScanPorts,
  options: ReadOptions,
): Promise<Result<RegistrationReadOnlyGateObservation, DomainError>> {
  switch (id) {
    case "local_repository":
      return ports.localRepository.inspect(options);
    case "node_runtime":
      return ports.nodeRuntime.inspect(options);
    case "agent_cli":
      return ports.compiledCli.inspect(options);
    case "github_access":
      return ports.github.inspect(options);
    case "linear_access":
      return ports.linear.inspect(options);
    case "continuous_integration":
      return ports.continuousIntegration.inspect(options);
    case "webhook_runtime":
      return ports.webhookRuntime.inspect(options);
  }
}

async function inspectBounded(
  id: RegistrationReadOnlyScanGateId,
  ports: RegistrationReadOnlyScanPorts,
  timeoutMs: number,
  options: ReadOptions,
): Promise<RegistrationScanGate> {
  if (options.signal?.aborted === true) {
    return unknownGate(id, "not_scanned", "interrupted", errorEvidence("interrupted"));
  }
  const controller = new AbortController();
  const forwardAbort = () => {
    controller.abort();
  };
  options.signal?.addEventListener("abort", forwardAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, timeoutMs);
      timer.unref();
    });
    const probeOutcome = Promise.resolve()
      .then(() => invokeProbe(id, ports, { signal: controller.signal }))
      .catch(() => err(domainError("external_failure")));
    const outcome = await Promise.race([probeOutcome, timedOut]);
    if (outcome === "timeout") {
      return unknownGate(id, "not_scanned", "timeout", errorEvidence("timeout"));
    }
    if (!outcome.ok) {
      const kind = errorKind(outcome.error);
      return unknownGate(id, "not_scanned", kind, errorEvidence(kind));
    }
    return normalizedGate(id, outcome.value);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}

function validTimeout(value: number | undefined): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 100 && value <= 30_000
    ? value
    : registrationProbeTimeoutMs;
}

/**
 * O002's coordinator is intentionally observational. It scans seven ports and
 * represents all remaining O001 Gates as unverified later work; it does not
 * transition the project into `registered`.
 */
export function createRegistrationReadOnlyScanUseCase(
  options: CreateRegistrationReadOnlyScanUseCaseOptions,
): RegistrationReadOnlyScanUseCase {
  const timeoutMs = validTimeout(options.timeoutMs);
  return Object.freeze({
    scan: async (readOptions: ReadOptions = {}) => {
      const scanned = await Promise.all(
        registrationReadOnlyScanGateIds.map((id) =>
          inspectBounded(id, options.ports, timeoutMs, readOptions),
        ),
      );
      const scannedById = new Map(scanned.map((gate) => [gate.id, gate]));
      const gates = Object.freeze(
        registrationGateIds.map((id) => scannedById.get(id) ?? deferredGate(id)),
      );
      const evaluation = evaluateRegistrationGates(
        Object.fromEntries(gates.map((gate) => [gate.id, gate.state])),
      );
      return Object.freeze({
        source: options.source,
        state: "configuration_incomplete" as const,
        stateLabel: registrationStateLabels.configuration_incomplete,
        complete: evaluation.complete,
        gates,
      });
    },
  });
}
