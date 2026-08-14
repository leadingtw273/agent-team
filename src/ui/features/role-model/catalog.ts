import type { AgentRole } from "../../../domain/project/index.js";
import type { ModelCandidate, ModelRoutingConfig } from "../../../application/routing/index.js";

export interface RoleModelCandidateCatalogEntry extends ModelCandidate {
  readonly providerLabel: "Codex" | "Claude" | "Gemini";
  readonly capabilities: readonly string[];
  readonly roles: readonly AgentRole[];
}

export interface RoleModelRoleDefinition {
  readonly role: AgentRole;
  readonly label: string;
  readonly description: string;
}

const allTextRoles = Object.freeze([
  "team_lead",
  "implementer",
  "code_reviewer",
  "visual_reviewer",
  "integration_engineer",
] as const satisfies readonly AgentRole[]);

export const roleModelRoleDefinitions: readonly RoleModelRoleDefinition[] = Object.freeze([
  Object.freeze({
    role: "team_lead",
    label: "團隊管理者",
    description: "釐清需求、整合決策與處理跨系統風險。",
  }),
  Object.freeze({
    role: "implementer",
    label: "開發工程師",
    description: "在隔離工作樹完成已核可的實作與驗證。",
  }),
  Object.freeze({
    role: "code_reviewer",
    label: "代碼審查者",
    description: "以獨立觀點檢查程式、測試與需求符合性。",
  }),
  Object.freeze({
    role: "visual_reviewer",
    label: "視覺審查者",
    description: "檢查畫面、互動與視覺證據是否符合驗收條件。",
  }),
  Object.freeze({
    role: "integration_engineer",
    label: "整合工程師",
    description: "處理語意衝突、整合風險與合併前的最後確認。",
  }),
]);

export const roleModelCandidateCatalog: readonly RoleModelCandidateCatalogEntry[] = Object.freeze([
  Object.freeze({
    provider: "codex",
    model: "gpt-5.6-sol",
    providerLabel: "Codex",
    capabilities: Object.freeze(["架構與整合", "複雜規劃", "高風險驗收"]),
    roles: Object.freeze([
      "team_lead",
      "implementer",
      "integration_engineer",
    ] satisfies readonly AgentRole[]),
  }),
  Object.freeze({
    provider: "codex",
    model: "gpt-5.6-terra",
    providerLabel: "Codex",
    capabilities: Object.freeze(["程式實作", "測試", "一般除錯"]),
    roles: Object.freeze([
      "team_lead",
      "implementer",
      "integration_engineer",
    ] satisfies readonly AgentRole[]),
  }),
  Object.freeze({
    provider: "claude",
    model: "opus",
    providerLabel: "Claude",
    capabilities: Object.freeze(["架構與整合", "複雜規劃", "獨立審查"]),
    roles: Object.freeze(["code_reviewer"] satisfies readonly AgentRole[]),
  }),
  Object.freeze({
    provider: "claude",
    model: "sonnet",
    providerLabel: "Claude",
    capabilities: Object.freeze(["程式實作", "一般審查", "測試"]),
    roles: Object.freeze(["code_reviewer"] satisfies readonly AgentRole[]),
  }),
  Object.freeze({
    provider: "gemini",
    model: "auto",
    providerLabel: "Gemini",
    capabilities: Object.freeze(["視覺審查", "圖像分析", "RWD 檢查"]),
    roles: Object.freeze(["visual_reviewer"] satisfies readonly AgentRole[]),
  }),
]);

function candidateKey(candidate: ModelCandidate): string {
  return `${candidate.provider}:${candidate.model}`;
}

const catalogByCandidate = new Map(
  roleModelCandidateCatalog.map((entry) => [candidateKey(entry), entry] as const),
);
const roleById = new Map(roleModelRoleDefinitions.map((entry) => [entry.role, entry] as const));

export function findRoleModelCandidate(
  candidate: ModelCandidate,
): RoleModelCandidateCatalogEntry | undefined {
  return catalogByCandidate.get(candidateKey(candidate));
}

export function findRoleModelRole(role: AgentRole): RoleModelRoleDefinition {
  const definition = roleById.get(role);
  if (definition === undefined) throw new TypeError("Unknown standard role.");
  return definition;
}

export function defaultRoleModelRoutingConfig(): ModelRoutingConfig {
  return {
    schemaVersion: 1,
    routes: allTextRoles.map((role) => {
      switch (role) {
        case "team_lead":
          return {
            role,
            candidates: [
              { provider: "codex", model: "gpt-5.6-sol" },
              { provider: "codex", model: "gpt-5.6-terra" },
            ],
          };
        case "implementer":
          return {
            role,
            candidates: [
              { provider: "codex", model: "gpt-5.6-terra" },
              { provider: "codex", model: "gpt-5.6-sol" },
            ],
          };
        case "code_reviewer":
          return {
            role,
            candidates: [{ provider: "claude", model: "opus" }],
          };
        case "visual_reviewer":
          return {
            role,
            candidates: [{ provider: "gemini", model: "auto" }],
          };
        case "integration_engineer":
          return {
            role,
            candidates: [
              { provider: "codex", model: "gpt-5.6-sol" },
              { provider: "codex", model: "gpt-5.6-terra" },
            ],
          };
      }
    }),
  };
}
