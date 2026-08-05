import { readFileSync } from "node:fs";

import type {
  GitHubRegistrationApplyOutcome,
  GitHubRegistrationPolicyUseCase,
  GitHubRegistrationPreview,
  GitHubRegistrationTarget,
} from "../../../application/registration/index.js";
import type { UiFeatureRoute } from "../../registry/index.js";
import type { UiRequest, UiResponse } from "../../server/index.js";
import type { UiSecurityRouteContract } from "../../security/index.js";

export const githubRegistrationPolicyApiPath = "/api/registration/github-policy" as const;
export const githubRegistrationPolicyScriptPath = "/assets/registration-github-policy.js" as const;

const revisionPattern = /^[a-f0-9]{64}$/u;
const confirmationPattern = /^[A-Za-z0-9_-]{20,4096}\.[A-Za-z0-9_-]{43}$/u;
const script = readFileSync(
  new URL("../../assets/registration-github-policy.js", import.meta.url),
  "utf8",
);

export interface GitHubRegistrationUiController {
  readonly preview: () => Promise<GitHubRegistrationPreview>;
  readonly apply: (
    command: Readonly<{
      expectedRevision: string;
      confirmationToken: string;
    }>,
  ) => Promise<GitHubRegistrationApplyOutcome>;
}

export interface GitHubRegistrationUiContribution {
  readonly scripts: readonly [typeof githubRegistrationPolicyScriptPath];
  readonly routes: readonly UiFeatureRoute[];
  readonly render: () => Promise<string>;
}

const routeContracts: readonly UiSecurityRouteContract[] = Object.freeze([
  Object.freeze({
    path: githubRegistrationPolicyScriptPath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: Object.freeze(["GET"] as const),
    response: "standard" as const,
  }),
  Object.freeze({
    path: githubRegistrationPolicyApiPath,
    allowedQueryParameters: Object.freeze([]),
    allowedMethods: Object.freeze(["PUT"] as const),
    response: "standard" as const,
    mutationBody: "bounded-json" as const,
  }),
]);

const changeLabels = Object.freeze({
  ensure_required_checks: "建立只會新增的 required checks：CI、agent-team/review",
  enable_auto_merge: "啟用 Squash Auto-merge；現有保護規則不會被修改或刪除",
} as const);

const blockLabels = Object.freeze({
  auto_merge_unsupported: "此 Repository 不支援 Auto-merge，設定維持未完成。",
  confirmation_invalid: "確認資料無效，請重新預覽後再確認。",
  inventory_changed: "GitHub 設定已改變，請重新預覽差異。",
  managed_ruleset_collision: "保留名稱已被其他規則占用；系統不會接管或覆寫。",
  operation_recovery_required: "GitHub 變更結果尚未安全確認；請人工復原後再繼續設定。",
  permission_required: "目前 GitHub 身分缺少管理權限，設定維持未完成。",
  provider_unavailable: "目前無法安全讀取 GitHub 設定，設定維持未完成。",
  read_back_incomplete: "套用後 Read-back 尚未證明必要 Gate，設定維持未完成。",
  rulesets_unsupported: "此 Repository 不支援必要 Ruleset API，設定維持未完成。",
} as const);

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/gu, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case "'":
        return "&#39;";
      case '"':
        return "&quot;";
      default:
        return character;
    }
  });
}

function jsonResponse(request: UiRequest, statusCode: number, value: unknown): UiResponse {
  const headers: Record<string, string> = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  };
  if (statusCode === 405) headers["allow"] = "PUT";
  return request.method === "HEAD"
    ? Object.freeze({ statusCode, headers: Object.freeze(headers) })
    : Object.freeze({ statusCode, headers: Object.freeze(headers), body: JSON.stringify(value) });
}

function assetResponse(request: UiRequest): UiResponse {
  const headers = Object.freeze({
    "cache-control": "no-store",
    "content-type": "text/javascript; charset=utf-8",
  });
  return request.method === "HEAD"
    ? Object.freeze({ statusCode: 200, headers })
    : Object.freeze({ statusCode: 200, headers, body: script });
}

function parseConfirmation(
  body: UiRequest["body"],
): Readonly<{ expectedRevision: string; confirmationToken: string }> | undefined {
  if (body === undefined || Object.keys(body).length !== 4) return undefined;
  const operation = body["operation"];
  const confirmationText = body["confirmationText"];
  const expectedRevision = body["expectedRevision"];
  const confirmationToken = body["confirmationToken"];
  return operation === "apply_github_policy" &&
    confirmationText === "套用 GitHub 合併保護" &&
    typeof expectedRevision === "string" &&
    revisionPattern.test(expectedRevision) &&
    typeof confirmationToken === "string" &&
    confirmationPattern.test(confirmationToken)
    ? Object.freeze({ expectedRevision, confirmationToken })
    : undefined;
}

export function createGitHubRegistrationUiController(
  policy: GitHubRegistrationPolicyUseCase,
  target: GitHubRegistrationTarget,
): GitHubRegistrationUiController {
  const boundTarget = Object.freeze({ ...target });
  return Object.freeze({
    preview: () => policy.preview(boundTarget),
    apply: (command: Parameters<GitHubRegistrationUiController["apply"]>[0]) =>
      policy.apply(
        Object.freeze({
          ...boundTarget,
          operation: "apply_github_policy",
          confirmationText: "套用 GitHub 合併保護",
          ...command,
        }),
      ),
  });
}

export async function handleGitHubRegistrationPolicyRequest(
  controller: GitHubRegistrationUiController,
  request: UiRequest,
): Promise<UiResponse> {
  if (request.method !== "PUT") {
    return jsonResponse(request, 405, { state: "error", code: "method_not_allowed" });
  }
  const command = parseConfirmation(request.body);
  if (command === undefined) {
    return jsonResponse(request, 422, { state: "error", code: "invalid_confirmation" });
  }
  const outcome = await controller.apply(command);
  if (outcome.state === "configured") {
    return jsonResponse(request, 200, { state: "configured", changed: outcome.changed });
  }
  const statusCode =
    outcome.reason === "inventory_changed"
      ? 409
      : outcome.reason === "confirmation_invalid"
        ? 422
        : 503;
  return jsonResponse(request, statusCode, { state: "blocked", reason: outcome.reason });
}

export function renderGitHubRegistrationPolicyPanel(preview: GitHubRegistrationPreview): string {
  const header = `<header><p class="ui-registration-card-eyebrow">O004 GitHub Merge Policy</p><h2 id="github-policy-title">GitHub 合併保護</h2></header>`;
  if (preview.state === "configured") {
    return `<section class="card ui-panel mt-3" data-github-policy-panel aria-labelledby="github-policy-title"><div class="card-body">${header}<p class="alert alert-success" role="status">Required CI、agent-team/review 與 Auto-merge 已由 Read-back 確認。</p></div></section>`;
  }
  if (preview.state === "blocked") {
    return `<section class="card ui-panel mt-3" data-github-policy-panel aria-labelledby="github-policy-title"><div class="card-body">${header}<p class="alert alert-warning" role="status">${escapeHtml(blockLabels[preview.reason])}</p></div></section>`;
  }
  const changes = preview.changes
    .map((change) => `<li>${escapeHtml(changeLabels[change])}</li>`)
    .join("");
  return `<section class="card ui-panel mt-3" data-github-policy-panel data-expected-revision="${preview.expectedRevision}" data-confirmation-token="${preview.confirmationToken}" aria-labelledby="github-policy-title"><div class="card-body">
    ${header}
    <p id="github-policy-status" class="alert alert-info" role="status" aria-live="polite">以下是純預覽；尚未變更 GitHub。</p>
    <ul aria-label="GitHub 設定差異">${changes}</ul>
    <button class="btn btn-primary" type="button" data-github-policy-review>檢視並確認套用</button>
    <section data-github-policy-confirm hidden aria-labelledby="github-policy-confirm-title">
      <h3 id="github-policy-confirm-title">確認套用 GitHub 合併保護</h3>
      <p>這會新增必要 Gate 並啟用 Auto-merge；不會刪除、停用、改名或降低現有保護。</p>
      <button class="btn btn-primary" type="button" data-github-policy-apply>確認套用</button>
      <button class="btn btn-outline-secondary" type="button" data-github-policy-cancel>取消</button>
    </section>
  </div></section>`;
}

export function createGitHubRegistrationUiContribution(
  controller: GitHubRegistrationUiController,
): GitHubRegistrationUiContribution {
  const contracts = new Map(routeContracts.map((contract) => [contract.path, contract]));
  const scriptContract = contracts.get(githubRegistrationPolicyScriptPath);
  const apiContract = contracts.get(githubRegistrationPolicyApiPath);
  if (scriptContract === undefined || apiContract === undefined) {
    throw new TypeError("Missing GitHub Registration UI route contract.");
  }
  return Object.freeze({
    scripts: Object.freeze([githubRegistrationPolicyScriptPath] as const),
    routes: Object.freeze([
      Object.freeze({
        contract: scriptContract,
        handler: (request: UiRequest) => assetResponse(request),
      }),
      Object.freeze({
        contract: apiContract,
        handler: (request: UiRequest) => handleGitHubRegistrationPolicyRequest(controller, request),
      }),
    ]),
    render: async () => renderGitHubRegistrationPolicyPanel(await controller.preview()),
  });
}
