import { randomUUID } from "node:crypto";

import type { RegistrationCliHandlers } from "../program.js";
import {
  registrationSetupFinalApprovalPhrase,
  registrationSetupPreviewConfirmationPhrase,
  type RegistrationSetupControllerActionResult,
} from "../../application/registration/index.js";
import { freshAuthorityDigest } from "./authority.js";
import { readStdinConfirmation } from "./confirmation.js";
import { buildRegistrationSetupComposition } from "./setup-composition.js";

export interface CreateRegistrationSetupHandlersOptions {
  readonly agentTeamHome: string;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly stdin?: AsyncIterable<Uint8Array | string>;
  /** Injectable for tests; production defaults to the real buildRegistrationSetupComposition. */
  readonly buildComposition?: typeof buildRegistrationSetupComposition;
}

type SetupHandlers = Pick<
  RegistrationCliHandlers,
  "setupStart" | "setupStatus" | "setupResume" | "setupRefresh" | "setupApprove"
>;

const blockedMessages: Readonly<Record<string, string>> = Object.freeze({
  draft_unavailable:
    "找不到有效的 Setup draft 檔（${AGENT_TEAM_HOME}/config/registration/<projectId>.draft.json 或 --draft），或格式不符 schema。",
  linear_api_key_missing: "缺少 LINEAR_API_KEY 環境變數。",
  github_authentication_unavailable: "gh 尚未通過身分驗證（gh auth status 失敗）。",
  configuration_incomplete: "Registration Setup production 依賴尚未完整就位。",
});

function outcome(state: "success" | "failed" | "blocked" | "rejected", payload: unknown) {
  return Object.freeze({ state, message: JSON.stringify(payload) });
}

function readModelOutcome(operation: string, model: RegistrationSetupControllerActionResult) {
  const blocked = model.state === "configuration_incomplete";
  return outcome(blocked ? "blocked" : "success", { operation, ...model });
}

/**
 * Composition roots are per-call rather than constructed once, because they read the host draft
 * file fresh each time (decision #4's "host is the live source of truth"): a build failure here
 * always maps to `blocked` (exit 3), never `failed`, matching decision #7.
 */
async function requireReadyComposition(
  options: CreateRegistrationSetupHandlersOptions,
  input: Readonly<{ projectId: string; draftPath?: string }>,
  ensureWorktreeDirectories: boolean,
) {
  const build = await (options.buildComposition ?? buildRegistrationSetupComposition)({
    agentTeamHome: options.agentTeamHome,
    projectId: input.projectId,
    ensureWorktreeDirectories,
    ...(input.draftPath === undefined ? {} : { draftPath: input.draftPath }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
  });
  if (build.state !== "ready") {
    return {
      ready: false as const,
      outcome: outcome("blocked", {
        operation: "registration_setup",
        state: "blocked",
        reason: build.reason,
        message: blockedMessages[build.reason] ?? "Registration Setup 尚未就位。",
      }),
    };
  }
  return { ready: true as const, composition: build.composition };
}

export function createRegistrationSetupHandlers(
  options: CreateRegistrationSetupHandlersOptions,
): SetupHandlers {
  const stdin = options.stdin ?? process.stdin;

  return Object.freeze({
    async setupStatus(input) {
      // Minor item #5 (2026-08-06 fresh-context acceptance review): a read-only command must
      // never create state/registration-setup/worktrees -- it just reports whatever the existing
      // controller.read() can honestly read back.
      const built = await requireReadyComposition(options, input, false);
      if (!built.ready) return built.outcome;
      const context = { authorityDigest: freshAuthorityDigest() };
      const model = await built.composition.controller.read(context);
      return readModelOutcome("registration_setup_status", model);
    },

    async setupResume(input) {
      const built = await requireReadyComposition(options, input, true);
      if (!built.ready) return built.outcome;
      const context = { authorityDigest: freshAuthorityDigest() };
      const model = await built.composition.controller.resume(
        { idempotencyKeyPrefix: `cli-setup-resume:${randomUUID()}` },
        context,
      );
      return readModelOutcome("registration_setup_resume", model);
    },

    /**
     * O009b (2026-08-06 E004 dry-run defect): `controller.refresh()` -- the only operation that
     * re-reads CI/`agent-team/review` evidence, posts the audit receipts, and advances
     * `ci_waiting` onward -- had no CLI entry point at all. `resume` cannot substitute: the
     * engine's own resume port only accepts `merge_authorized`/`merge_pending`/`activated`
     * (setup.ts's resume-eligibility gate), and `approve`'s own precondition requires
     * `awaiting_user_approval` already. Without this command, `ci_waiting` was a dead end on the
     * CLI even after real CI turned green. `refresh()` requires the exact `setupSessionId` the
     * engine's own preview derivation is currently using (RegistrationSetupRefreshCommand,
     * setup-controller.ts) -- read() first, exactly mirroring how setupStart already obtains it
     * before confirmPreview/start.
     *
     * No stdin confirmation: refresh is an idempotent, evidence-driven *advance*, not a new
     * mutation decision -- it never creates anything a human needs to explicitly authorize (the
     * three phrases remain start/approve/probe-run only, per the O009 packet).
     */
    async setupRefresh(input) {
      const built = await requireReadyComposition(options, input, true);
      if (!built.ready) return built.outcome;
      const controller = built.composition.controller;
      const context = { authorityDigest: freshAuthorityDigest() };
      const current = await controller.read(context);
      if (current.preview === undefined) {
        return readModelOutcome("registration_setup_refresh", current);
      }
      const refreshed = await controller.refresh(
        {
          setupSessionId: current.preview.setupSessionId,
          idempotencyKeyPrefix: `cli-setup-refresh:${randomUUID()}`,
        },
        context,
      );
      return readModelOutcome("registration_setup_refresh", refreshed);
    },

    async setupStart(input) {
      const confirmation = await readStdinConfirmation(stdin);
      if (!confirmation.ok || confirmation.value !== registrationSetupPreviewConfirmationPhrase) {
        return outcome("rejected", {
          operation: "registration_setup_start",
          state: "rejected",
          reason: "confirmation_mismatch",
        });
      }
      const built = await requireReadyComposition(options, input, true);
      if (!built.ready) return built.outcome;
      const controller = built.composition.controller;
      const context = { authorityDigest: freshAuthorityDigest() };
      const preview = await controller.read(context);
      if (preview.state !== "preview_ready" || preview.preview === undefined) {
        return readModelOutcome("registration_setup_start", preview);
      }
      const confirmed = await controller.confirmPreview(
        {
          setupSessionId: preview.preview.setupSessionId,
          previewDigest: preview.preview.previewDigest,
          confirmation: confirmation.value,
          idempotencyKey: `cli-setup-start-confirm:${randomUUID()}`,
        },
        context,
      );
      if (confirmed.state !== "preview_confirmation_issued") {
        return readModelOutcome("registration_setup_start", confirmed);
      }
      const started = await controller.start(
        {
          setupSessionId: confirmed.setupSessionId,
          previewDigest: confirmed.previewDigest,
          tokenId: confirmed.tokenId,
          idempotencyKeyPrefix: `cli-setup-start:${randomUUID()}`,
        },
        context,
      );
      return readModelOutcome("registration_setup_start", started);
    },

    async setupApprove(input) {
      const confirmation = await readStdinConfirmation(stdin);
      if (!confirmation.ok || confirmation.value !== registrationSetupFinalApprovalPhrase) {
        return outcome("rejected", {
          operation: "registration_setup_approve",
          state: "rejected",
          reason: "confirmation_mismatch",
        });
      }
      const built = await requireReadyComposition(options, input, true);
      if (!built.ready) return built.outcome;
      const controller = built.composition.controller;
      const context = { authorityDigest: freshAuthorityDigest() };
      const current = await controller.read(context);
      if (current.state !== "awaiting_user_approval" || current.session === undefined) {
        return readModelOutcome("registration_setup_approve", current);
      }
      const intent = await controller.issueLocalUiApprovalIntent(
        {
          setupSessionId: current.session.setupSessionId,
          idempotencyKeyPrefix: `cli-setup-approve-intent:${randomUUID()}`,
          expectedSetupRevision: current.session.revision,
          confirmation: confirmation.value,
          idempotencyKey: `cli-setup-approve-intent-key:${randomUUID()}`,
        },
        context,
      );
      if (intent.state !== "approval_intent_issued") {
        return readModelOutcome("registration_setup_approve", intent);
      }
      const merged = await controller.approveAndMergeLocalUi(
        {
          setupSessionId: intent.setupSessionId,
          idempotencyKeyPrefix: `cli-setup-approve-merge:${randomUUID()}`,
          approvalId: intent.approvalId,
          expectedSetupRevision: intent.expectedSetupRevision,
        },
        context,
      );
      return readModelOutcome("registration_setup_approve", merged);
    },
  });
}
