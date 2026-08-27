import { createHash, randomBytes } from "node:crypto";

import type { ReadOptions } from "../ports/common.js";
import type { DomainError, Result } from "../../domain/foundation/index.js";

export const linearProvisionObjectKinds = [
  "workflow_state",
  "label_group",
  "label",
  "form_template",
] as const;

export type LinearProvisionObjectKind = (typeof linearProvisionObjectKinds)[number];
export type LinearProvisionCapability = "automatic" | "manual";

export interface LinearProvisionTarget {
  readonly teamId: string;
  readonly projectId: string;
}

export interface LinearProvisionDesiredObject {
  readonly key: string;
  readonly kind: LinearProvisionObjectKind;
  readonly name: string;
  readonly parentKey?: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly fingerprint: string;
}

export interface LinearProvisionRemoteObject {
  readonly id: string;
  readonly kind: LinearProvisionObjectKind;
  readonly name: string;
  readonly teamId: string;
  readonly parentId?: string;
  readonly fingerprint: string;
}

export interface LinearProvisionInventory {
  readonly target: LinearProvisionTarget;
  readonly objects: readonly LinearProvisionRemoteObject[];
  readonly capabilities: Readonly<Record<LinearProvisionObjectKind, LinearProvisionCapability>>;
}

export interface LinearProvisionBindings {
  /** Store-owned, monotonically increasing decimal revision. */
  readonly revision: string;
  readonly byKey: Readonly<Record<string, string>>;
  readonly reservations: Readonly<Record<string, LinearProvisionReservation>>;
}

export type LinearProvisionReservationPhase =
  "reserved" | "mutation_started" | "verification_pending";

export interface LinearProvisionReservation {
  readonly logicalKey: string;
  readonly operation: "provision" | "manual_readback";
  readonly ownerDigest: string;
  readonly desiredFingerprint: string;
  readonly phase: LinearProvisionReservationPhase;
  readonly candidateRemoteId?: string;
  readonly candidateResourceFingerprint?: string;
  readonly authoritativeInventoryDigest?: string;
  readonly confirmationProofDigest?: string;
}

export interface LinearProvisionBindingMutation {
  readonly byKey: Readonly<Record<string, string>>;
  readonly reservations: Readonly<Record<string, LinearProvisionReservation>>;
}

export interface LinearProvisionCreateReceipt {
  readonly id: string;
}

export interface LinearProvisionPort {
  readonly readInventory: (
    target: LinearProvisionTarget,
    options?: ReadOptions,
  ) => Promise<Result<LinearProvisionInventory, DomainError>>;
  readonly create: (
    target: LinearProvisionTarget,
    desired: LinearProvisionDesiredObject,
    parentId: string | undefined,
    options?: ReadOptions,
  ) => Promise<Result<LinearProvisionCreateReceipt, DomainError>>;
}

export interface LinearProvisionBindingPort {
  readonly read: (
    target: LinearProvisionTarget,
    options?: ReadOptions,
  ) => Promise<Result<LinearProvisionBindings, DomainError>>;
  readonly compareAndSwap: (
    target: LinearProvisionTarget,
    expectedRevision: string,
    next: LinearProvisionBindingMutation,
    options?: ReadOptions,
  ) => Promise<Result<LinearProvisionBindings, DomainError>>;
}

export const linearProvisionActionStates = [
  "unchanged",
  "create",
  "manual_create",
  "manual_readback",
  "conflict",
] as const;

export type LinearProvisionActionState = (typeof linearProvisionActionStates)[number];

export interface LinearProvisionAction {
  readonly key: string;
  readonly kind: LinearProvisionObjectKind;
  readonly name: string;
  readonly state: LinearProvisionActionState;
  readonly instruction?: string;
}

export interface LinearProvisionPreview {
  readonly state: "ready" | "incomplete";
  readonly target: LinearProvisionTarget;
  readonly expectedRevision: string;
  readonly confirmationToken: string;
  readonly actions: readonly LinearProvisionAction[];
  readonly summary: Readonly<{
    unchanged: number;
    create: number;
    manual: number;
    conflict: number;
  }>;
}

export interface LinearProvisionCommand {
  readonly operation: "provision";
  readonly expectedRevision: string;
  readonly confirmationToken: string;
  readonly confirmationText: "套用 Linear 設定";
}

export interface LinearManualReadBackRequest {
  readonly logicalKey: string;
  readonly remoteId: string;
}

export interface LinearManualReadBackPreview {
  readonly operation: "manual_readback";
  readonly state: "ready";
  readonly logicalKey: string;
  readonly name: string;
  readonly expectedRevision: string;
  readonly confirmationToken: string;
}

export interface LinearManualReadBackCommand extends LinearManualReadBackRequest {
  readonly operation: "manual_readback";
  readonly expectedRevision: string;
  readonly confirmationToken: string;
  readonly confirmationText: "確認 Linear ID read-back";
}

export interface LinearProvisionConfirmationContext {
  /** One-way digest scoped to one localhost UI/session lifecycle; never the raw session secret. */
  readonly digest: string;
}

export interface LinearProvisionUseCaseOptions {
  readonly confirmationContext: LinearProvisionConfirmationContext;
  readonly desiredObjects?: readonly LinearProvisionDesiredObject[];
}

export interface LinearProvisionOutcome {
  readonly state: "complete" | "incomplete";
  readonly createdKeys: readonly string[];
  readonly preview: LinearProvisionPreview;
}

/**
 * C015b: single source of truth for the Ready Gate template's section headings. The C015b
 * requirement-template parser (src/adapters/linear/requirement-template.ts) imports these
 * constants directly rather than duplicating the heading strings -- if this template's wording
 * ever changes, the parser changes with it automatically instead of silently drifting apart and
 * failing to recognize real Linear issues.
 */
export const readyGateTemplateHeadings = Object.freeze({
  goal: "目標（必填）",
  background: "背景（必填）",
  acceptanceCriteria: "驗收條件（必填）",
  inScope: "範圍內（必填）",
  outOfScope: "範圍外（必填）",
  dependencies: "依賴關係（必填；沒有請填「無」）",
  estimatedMinutes: "預估體量（必填；目標 15～30 分鐘，超過 45 分鐘先拆單）",
  constraints: "補充限制（選填）",
  risks: "預期風險（選填）",
  changeRegions: "預期變更區域（選填）",
  skillSelections: "使用 Skills（選填）",
} as const);

export const humanSummaryTemplate = Object.freeze({
  heading: "人類摘要（給專案負責人）",
  objective: "要做什麼",
  outcome: "完成後會看到／能操作什麼",
  acceptance: "如何驗收",
} as const);

/** The literal placeholder text the template asks the human to overwrite. Also a shared constant
 * so the C015b parser can recognize an untouched placeholder as "not actually filled in" rather
 * than treating it as real content. */
export const readyGateTemplatePlaceholder = "（請填寫）";

const readyGateTemplateDescription = `## ${humanSummaryTemplate.heading}
- ${humanSummaryTemplate.objective}：${readyGateTemplatePlaceholder}
- ${humanSummaryTemplate.outcome}：${readyGateTemplatePlaceholder}
- ${humanSummaryTemplate.acceptance}：${readyGateTemplatePlaceholder}

## ${readyGateTemplateHeadings.goal}

## ${readyGateTemplateHeadings.background}

## ${readyGateTemplateHeadings.acceptanceCriteria}
- ${readyGateTemplatePlaceholder}

## ${readyGateTemplateHeadings.inScope}
- ${readyGateTemplatePlaceholder}

## ${readyGateTemplateHeadings.outOfScope}
- ${readyGateTemplatePlaceholder}

## ${readyGateTemplateHeadings.dependencies}

## ${readyGateTemplateHeadings.estimatedMinutes}

## ${readyGateTemplateHeadings.constraints}

## ${readyGateTemplateHeadings.risks}

## ${readyGateTemplateHeadings.skillSelections}
無

## ${readyGateTemplateHeadings.changeRegions}`;

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Readonly<Record<string, unknown>>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function linearProvisionDigest(value: unknown): string {
  return createHash("sha256").update(canonical(value), "utf8").digest("hex");
}

export function createLinearProvisionConfirmationContext(
  entropy: Uint8Array = randomBytes(32),
): LinearProvisionConfirmationContext {
  if (entropy.byteLength < 32) throw new TypeError("Linear confirmation entropy is too short.");
  return Object.freeze({
    digest: createHash("sha256").update(entropy).digest("hex"),
  });
}

function desired(
  key: string,
  kind: LinearProvisionObjectKind,
  name: string,
  payload: Readonly<Record<string, unknown>>,
  parentKey?: string,
): LinearProvisionDesiredObject {
  return Object.freeze({
    key,
    kind,
    name,
    ...(parentKey === undefined ? {} : { parentKey }),
    payload: Object.freeze({ ...payload }),
    fingerprint: linearProvisionDigest(payload),
  });
}

const workStatuses = [
  ["backlog", "待辦", "backlog"],
  ["ready", "待執行", "unstarted"],
  ["requires_manual", "需人工", "unstarted"],
  ["in_progress", "進行中", "started"],
  ["in_review", "審查中", "started"],
  ["completed", "已完成", "completed"],
  ["canceled", "已取消", "canceled"],
] as const;

const labelGroups = [
  [
    "agent_role",
    "Agent 角色",
    ["團隊管理者", "開發工程師", "代碼審查者", "視覺審查者", "整合工程師"],
  ],
  ["review_requirement", "審查需求", ["代碼審查", "視覺審查", "雙重審查"]],
  ["human_acceptance", "人類驗收", ["需要", "不需要"]],
  ["verification_level", "驗證強度", ["輕量", "標準", "嚴格"]],
  ["agent_status", "Agent 狀態", ["排隊中", "執行中", "等待中", "已暫停", "已阻塞"]],
  [
    "blocking_reason",
    "阻塞原因",
    [
      "等待依賴",
      "週額度不足",
      "5 小時額度限制",
      "額度資訊無法確認",
      "等待危險操作核可",
      "整合異常",
      "合併衝突",
      "變更請求已關閉",
      "未知錯誤",
    ],
  ],
] as const;

function slug(value: string): string {
  return linearProvisionDigest(value).slice(0, 12);
}

/** Fixed O003 catalog. Display names are product-owned, never provider-owned strings. */
export const linearProvisionDesiredObjects: readonly LinearProvisionDesiredObject[] = Object.freeze(
  [
    ...workStatuses.map(([key, name, type]) =>
      desired(`work_status.${key}`, "workflow_state", name, { type }),
    ),
    ...labelGroups.flatMap(([groupKey, groupName, childNames]) => {
      const parentKey = `label_group.${groupKey}`;
      return [
        desired(parentKey, "label_group", groupName, {
          color: "#5E6AD2",
          description: `Agent Team 管理的${groupName}單選群組。`,
          isGroup: true,
        }),
        ...childNames.map((name) =>
          desired(
            `label.${groupKey}.${slug(name)}`,
            "label",
            name,
            {
              color: "#26B5CE",
              description: `Agent Team 管理的${groupName}值。`,
              isGroup: false,
            },
            parentKey,
          ),
        ),
      ];
    }),
    desired("form_template.ready_gate", "form_template", "Agent Team｜需求受理", {
      type: "issue",
      description: "Agent Team Ready Gate 中文需求表單。",
      templateData: Object.freeze({
        title: "請用一句白話描述完成後的結果",
        description: readyGateTemplateDescription,
      }),
    }),
  ],
);
