import { Command, CommanderError, Option } from "commander";

import type { SystemdCommandInput } from "./systemd/index.js";

export interface PackageMetadata {
  readonly description: string;
  readonly version: string;
}

export const cliExitCodes = Object.freeze({
  success: 0,
  failure: 1,
  usage: 2,
  blocked: 3,
  interrupted: 130,
} as const);

export type CliCommandOutcome = Readonly<
  | { state: "success"; message?: string }
  | { state: "failed"; message: string }
  | { state: "blocked"; message: string }
  /**
   * Usage-level rejection with guaranteed zero side effects (e.g. a wrong stdin confirmation
   * phrase). Distinct from `blocked` (missing configuration): maps to exit code 2, mirroring how
   * Commander's own argument-parsing errors are reported.
   */
  | { state: "rejected"; message: string }
  | { state: "interrupted"; message: string }
>;

export interface RegistrationCliHandlers {
  readonly setupStart: (
    input: Readonly<{ projectId: string; draftPath?: string }>,
  ) => Promise<CliCommandOutcome>;
  readonly setupStatus: (input: Readonly<{ projectId: string }>) => Promise<CliCommandOutcome>;
  readonly setupResume: (input: Readonly<{ projectId: string }>) => Promise<CliCommandOutcome>;
  readonly setupRefresh: (input: Readonly<{ projectId: string }>) => Promise<CliCommandOutcome>;
  readonly setupApprove: (
    input: Readonly<{ projectId: string; draftPath?: string }>,
  ) => Promise<CliCommandOutcome>;
  readonly probeRun: (input: Readonly<{ projectId: string }>) => Promise<CliCommandOutcome>;
  readonly probeStatus: (input: Readonly<{ projectId: string }>) => Promise<CliCommandOutcome>;
}

/** Q01's host-only, stdin-bound attestation commands. They deliberately take no IDs, version, or
 * confirmation phrase from argv, so shell history and process listings never carry those values. */
export interface QuotaCliHandlers {
  readonly canaryConfirm: () => Promise<CliCommandOutcome>;
  readonly canaryStatus: () => Promise<CliCommandOutcome>;
  readonly probeStatus?: (
    input: Readonly<{ provider: "claude" | "codex" | "all" }>,
  ) => Promise<CliCommandOutcome>;
}

export interface CliHandlers {
  readonly run: (
    input: Readonly<{ projectId?: string; dryRun?: boolean }>,
  ) => Promise<CliCommandOutcome>;
  /** C015o decision 4: the human-issued escape hatch out of `requires_manual` (or any other
   * stuck, non-terminal job-progress stage) -- see src/cli/dispatch/resolve-handlers.ts's own
   * header for the full rationale. */
  readonly dispatchResolve: (
    input: Readonly<{ jobId: string; as: "superseded" | "cancelled"; supersededByJobId?: string }>,
  ) => Promise<CliCommandOutcome>;
  /** C016: the controlled repair path for an admission claim with no job-progress record to
   * resolve against at all -- see src/cli/dispatch/legacy-claim-handlers.ts's own header for the
   * full rationale. Never a substitute for `dispatchResolve` above. */
  readonly dispatchResolveLegacyClaim: (
    input: Readonly<{ jobId: string; projectId: string; issueId: string; note: string }>,
  ) => Promise<CliCommandOutcome>;
  /** E116cap: the human-issued escape hatch out of a project-level auto-merge pause -- see
   * src/cli/dispatch/auto-merge-pause-handlers.ts's own header for the full rationale. */
  readonly dispatchAutoMergeResume: (
    input: Readonly<{ projectId: string }>,
  ) => Promise<CliCommandOutcome>;
  readonly dispatchReviewerResume: (
    input: Readonly<{ jobId: string }>,
  ) => Promise<CliCommandOutcome>;
  readonly dispatchReviewerReplay: (
    input: Readonly<{
      jobId: string;
      dryRun?: boolean;
      newContractEpoch?: boolean;
      expectContractVersion?: number;
      finalReviewEpoch?: boolean;
      expectCheckpoint?: string;
    }>,
  ) => Promise<CliCommandOutcome>;
  readonly dispatchReviewerReplayPolicy: (
    input: Readonly<{ projectId: string; enabled: boolean }>,
  ) => Promise<CliCommandOutcome>;
  readonly dispatchWorkStatusRecover: (
    input: Readonly<{ jobId: string; transitionInstance: string; dryRun?: boolean }>,
  ) => Promise<CliCommandOutcome>;
  readonly dispatchCiResume?: (
    input: Readonly<{ jobId: string; dryRun?: boolean }>,
  ) => Promise<CliCommandOutcome>;
  readonly dispatchJobResume?: (
    input: Readonly<{ jobId: string; dryRun?: boolean }>,
  ) => Promise<CliCommandOutcome>;
  readonly ingest: (
    input: Readonly<{ provider: "github" | "linear"; headersFile: string }>,
  ) => Promise<CliCommandOutcome>;
  readonly reconcile: (
    input: Readonly<{ all: true }> | Readonly<{ jobId: string }>,
  ) => Promise<CliCommandOutcome>;
  readonly cycle: (input: Readonly<{ all: true }>) => Promise<CliCommandOutcome>;
  readonly health: () => Promise<CliCommandOutcome>;
  readonly project: (input: Readonly<{ projectId?: string }>) => Promise<CliCommandOutcome>;
  readonly ui: () => Promise<CliCommandOutcome>;
  readonly systemd: (input: SystemdCommandInput) => Promise<CliCommandOutcome>;
  readonly registration: RegistrationCliHandlers;
  readonly quota: QuotaCliHandlers;
}

export interface CliIo {
  readonly writeOut: (message: string) => void;
  readonly writeErr: (message: string) => void;
}

interface CliExecutionState {
  exitCode: number;
}

function blocked(command: string): Promise<CliCommandOutcome> {
  return Promise.resolve({
    state: "blocked",
    message: `${command} 尚未接上 Runtime composition；請完成對應後續階段。`,
  });
}

const defaultRegistrationHandlers: RegistrationCliHandlers = Object.freeze({
  setupStart: () => blocked("registration setup start"),
  setupStatus: () => blocked("registration setup status"),
  setupResume: () => blocked("registration setup resume"),
  setupRefresh: () => blocked("registration setup refresh"),
  setupApprove: () => blocked("registration setup approve"),
  probeRun: () => blocked("registration probe run"),
  probeStatus: () => blocked("registration probe status"),
});

const defaultQuotaHandlers: QuotaCliHandlers = Object.freeze({
  canaryConfirm: () =>
    Promise.resolve({
      state: "blocked" as const,
      message: JSON.stringify({
        operation: "operator_canary_confirm",
        state: "blocked",
        reason: "runtime_unavailable",
      }),
    }),
  canaryStatus: () =>
    Promise.resolve({
      state: "blocked" as const,
      message: JSON.stringify({
        operation: "operator_canary_status",
        state: "blocked",
        reason: "runtime_unavailable",
      }),
    }),
  probeStatus: () =>
    Promise.resolve({
      state: "blocked" as const,
      message: JSON.stringify({
        schema: "agent-team-quota-probe-status",
        version: 1,
        results: [{ provider: "all", state: "unknown", reason: "runtime_unavailable" }],
      }),
    }),
});

export const defaultCliHandlers: CliHandlers = Object.freeze({
  run: () => blocked("run"),
  dispatchResolve: () => blocked("dispatch resolve"),
  dispatchResolveLegacyClaim: () => blocked("dispatch resolve-legacy-claim"),
  dispatchAutoMergeResume: () => blocked("dispatch auto-merge-resume"),
  dispatchReviewerResume: () => blocked("dispatch reviewer-resume"),
  dispatchReviewerReplay: () => blocked("dispatch reviewer-replay"),
  dispatchReviewerReplayPolicy: () => blocked("dispatch reviewer-replay-policy"),
  dispatchWorkStatusRecover: () => blocked("dispatch work-status-recover"),
  dispatchCiResume: () => blocked("dispatch ci-resume"),
  ingest: () => blocked("ingest"),
  reconcile: () => blocked("reconcile"),
  cycle: () => blocked("cycle"),
  health: () => blocked("health"),
  project: () => blocked("project"),
  ui: () => blocked("ui"),
  systemd: () => blocked("systemd"),
  registration: defaultRegistrationHandlers,
  quota: defaultQuotaHandlers,
});

const defaultIo: CliIo = Object.freeze({
  writeOut: (message: string) => process.stdout.write(message),
  writeErr: (message: string) => process.stderr.write(message),
});

function outcomeExitCode(outcome: CliCommandOutcome): number {
  switch (outcome.state) {
    case "success":
      return cliExitCodes.success;
    case "failed":
      return cliExitCodes.failure;
    case "blocked":
      return cliExitCodes.blocked;
    case "rejected":
      return cliExitCodes.usage;
    case "interrupted":
      return cliExitCodes.interrupted;
  }
}

/** Commander includes unexpected positional values in its diagnostic text. The two Q01 commands
 * expressly forbid raw IDs/version/confirmation from argv, so reject surplus argv before the
 * parser has a chance to echo it to stderr. Exact invocations still flow through Commander and
 * the strict stdin handlers below. */
function operatorCanaryArgvRejection(argv: readonly string[]): CliCommandOutcome | undefined {
  const command = argv[0] === "quota" ? argv[1] : undefined;
  if (command !== "canary-confirm" && command !== "canary-status") return undefined;
  if (argv.length === 2) return undefined;
  return Object.freeze({
    state: "rejected" as const,
    message: JSON.stringify({
      operation:
        command === "canary-confirm" ? "operator_canary_confirm" : "operator_canary_status",
      state: "rejected",
      reason: "invalid_command_input",
    }),
  });
}

/** The diagnostic provider is a closed allowlist. Reject every other argv shape before Commander
 * can echo an operator-supplied value into stderr. */
function quotaProbeArgvRejection(argv: readonly string[]): CliCommandOutcome | undefined {
  if (argv[0] !== "quota" || argv[1] !== "probe-status") return undefined;
  if (
    argv.length === 4 &&
    argv[2] === "--provider" &&
    (argv[3] === "claude" || argv[3] === "codex" || argv[3] === "all")
  ) {
    return undefined;
  }
  return Object.freeze({
    state: "rejected" as const,
    message: JSON.stringify({
      schema: "agent-team-quota-probe-status",
      version: 1,
      state: "rejected",
      reason: "invalid_command_input",
    }),
  });
}

/** `cycle` is an operator-free, fixed invocation: reject every non-exact argv before Commander
 * can echo an unexpected value or invoke a handler that may create the singleton lock. */
function controllerCycleArgvRejection(argv: readonly string[]): CliCommandOutcome | undefined {
  if (argv[0] !== "cycle") return undefined;
  if (argv.length === 2 && argv[1] === "--all") return undefined;
  return Object.freeze({
    state: "rejected" as const,
    message: JSON.stringify({
      operation: "controller_cycle",
      state: "rejected",
      reason: "invalid_command_input",
    }),
  });
}

function renderOutcome(outcome: CliCommandOutcome, io: CliIo): void {
  if (outcome.message === undefined) return;
  const line = outcome.message.endsWith("\n") ? outcome.message : `${outcome.message}\n`;
  if (outcome.state === "success") io.writeOut(line);
  else io.writeErr(line);
}

function action(
  state: CliExecutionState,
  io: CliIo,
  handler: () => Promise<CliCommandOutcome>,
): () => Promise<void> {
  return async () => {
    const outcome = await handler();
    state.exitCode = outcomeExitCode(outcome);
    renderOutcome(outcome, io);
  };
}

export function createProgram(
  metadata: PackageMetadata,
  handlers: CliHandlers = defaultCliHandlers,
  io: CliIo = defaultIo,
  state: CliExecutionState = { exitCode: cliExitCodes.success },
): Command {
  const program = new Command()
    .name("agent-team")
    .description(metadata.description)
    .version(metadata.version)
    .showHelpAfterError()
    .configureOutput({ writeOut: io.writeOut, writeErr: io.writeErr });

  program
    .command("run")
    .description("輪詢 Linear 待執行工單、恢復既有 Job，並驅動 implementer pipeline")
    .requiredOption("--project <project-id>", "專案識別碼")
    .option("--dry-run", "只印出候選與 eligibility 結果，不取租約、不建 Job")
    .action((options: { readonly project: string; readonly dryRun?: boolean }) =>
      action(state, io, () =>
        handlers.run({
          projectId: options.project,
          ...(options.dryRun === true ? { dryRun: true } : {}),
        }),
      )(),
    );

  const dispatch = program.command("dispatch").description("C015o：手動收斂卡住的 dispatch job");
  dispatch
    .command("resolve")
    .description(
      "以 stdin 確認字串把一個非終態的 job-progress 記錄（例如 requires_manual）標記為" +
        " superseded 或 cancelled，並釋放其 issue admission claim（唯一能安全放行重新派工的方式）",
    )
    .requiredOption("--job <job-id>", "job-progress 記錄的 job id")
    .addOption(
      new Option("--as <verdict>", "終態判定")
        .choices(["superseded", "cancelled"])
        .makeOptionMandatory(),
    )
    .option("--superseded-by <job-id>", "取代此 job 的新 job id（--as superseded 時必填）")
    .action(
      (options: {
        readonly job: string;
        readonly as: "superseded" | "cancelled";
        readonly supersededBy?: string;
      }) =>
        action(state, io, () =>
          handlers.dispatchResolve({
            jobId: options.job,
            as: options.as,
            ...(options.supersededBy === undefined
              ? {}
              : { supersededByJobId: options.supersededBy }),
          }),
        )(),
    );

  dispatch
    .command("reviewer-resume")
    .description(
      "在確認 Claude 可用後，將無可信 reset 的 reviewer_waiting job 受控移回 awaiting_review；" +
        "不釋放 admission，也不重跑 implementer",
    )
    .requiredOption("--job <job-id>", "job-progress 記錄的 job id")
    .action((options: { readonly job: string }) =>
      action(state, io, () => handlers.dispatchReviewerResume({ jobId: options.job }))(),
    );

  dispatch
    .command("reviewer-replay")
    .description(
      "只針對既有 requires_manual(review_report_contract) Job 重做有界 Reviewer 審查，" +
        "成功 checkpoint 後接回既有 merge/lifecycle",
    )
    .requiredOption("--job <job-id>", "既有 job-progress 記錄的 job id")
    .option("--dry-run", "只做 admission、權威 read-back、identity 與預計 mutation 檢查")
    .option("--new-contract-epoch", "顯式封存已耗盡 epoch 並建立一次 contract 修正版 epoch")
    .option(
      "--expect-contract-version <version>",
      "建立新 epoch 時操作者預期的 committed reviewer contract version",
    )
    .option("--final-review-epoch", "只救回 exact paused(retry_exhausted) 最終代碼審查")
    .option("--expect-checkpoint <checkpoint-id>", "final-review epoch 綁定的既有 checkpoint id")
    .action(
      (options: {
        readonly job: string;
        readonly dryRun?: boolean;
        readonly newContractEpoch?: boolean;
        readonly expectContractVersion?: string;
        readonly finalReviewEpoch?: boolean;
        readonly expectCheckpoint?: string;
      }) =>
        action(state, io, () =>
          handlers.dispatchReviewerReplay({
            jobId: options.job,
            ...(options.dryRun === true ? { dryRun: true } : {}),
            ...(options.newContractEpoch === true ? { newContractEpoch: true } : {}),
            ...(options.expectContractVersion === undefined
              ? {}
              : { expectContractVersion: Number(options.expectContractVersion) }),
            ...(options.finalReviewEpoch === true ? { finalReviewEpoch: true } : {}),
            ...(options.expectCheckpoint === undefined
              ? {}
              : { expectCheckpoint: options.expectCheckpoint }),
          }),
        )(),
    );

  dispatch
    .command("ci-resume")
    .description(
      "只針對既有 requires_manual(ci_recovery_paused) Job，在同 Head CI 權威成功後接回既有流程",
    )
    .requiredOption("--job <job-id>", "既有 job-progress 記錄的 job id")
    .option("--dry-run", "只做 Job、claim、PR、Head、CI 與 Linear identity 檢查")
    .action((options: { readonly job: string; readonly dryRun?: boolean }) =>
      action(
        state,
        io,
        () =>
          handlers.dispatchCiResume?.({
            jobId: options.job,
            ...(options.dryRun === true ? { dryRun: true } : {}),
          }) ?? blocked("dispatch ci-resume"),
      )(),
    );

  dispatch
    .command("job-resume")
    .description("只續跑一個既有 resumable Job 的精確 revision；不做 discovery、不建立新 Job")
    .requiredOption("--job <job-id>", "既有 job-progress 記錄的 job id")
    .option("--dry-run", "只做 Job、claim、revision 與 resumable admission 檢查")
    .action((options: { readonly job: string; readonly dryRun?: boolean }) =>
      action(
        state,
        io,
        () =>
          handlers.dispatchJobResume?.({
            jobId: options.job,
            ...(options.dryRun === true ? { dryRun: true } : {}),
          }) ?? blocked("dispatch job-resume"),
      )(),
    );

  dispatch
    .command("work-status-recover")
    .description(
      "顯式收斂既有 work-status authority ambiguity；只接受 exact Job 與 transition instance",
    )
    .requiredOption("--job <job-id>", "既有 job-progress 記錄的 job id")
    .requiredOption("--transition <digest>", "既有 lifecycle transition instance digest")
    .option("--dry-run", "只做 admission、identity、history 與預計 mutation 檢查")
    .action(
      (options: { readonly job: string; readonly transition: string; readonly dryRun?: boolean }) =>
        action(state, io, () =>
          handlers.dispatchWorkStatusRecover({
            jobId: options.job,
            transitionInstance: options.transition,
            ...(options.dryRun === true ? { dryRun: true } : {}),
          }),
        )(),
    );

  dispatch
    .command("reviewer-replay-policy")
    .description("以 stdin 確認字串啟用或停用 project-level reviewer-replay kill switch")
    .requiredOption("--project <project-id>", "專案識別碼")
    .addOption(
      new Option("--state <state>", "目標狀態")
        .choices(["enabled", "disabled"])
        .makeOptionMandatory(),
    )
    .action((options: { readonly project: string; readonly state: "enabled" | "disabled" }) =>
      action(state, io, () =>
        handlers.dispatchReviewerReplayPolicy({
          projectId: options.project,
          enabled: options.state === "enabled",
        }),
      )(),
    );

  dispatch
    .command("resolve-legacy-claim")
    .description(
      "C016：受控復原一個沒有對應 job-progress 記錄的既有 admission claim" +
        "（僅限本工具自身缺陷造成的舊 claim，不是 dispatch resolve 的替代品，" +
        "後者才是正常情況下唯一該用的收斂方式）。以 stdin 確認字串驗證" +
        " claim.jobId 與所給 --job 完全相符後才釋放，並在 claim 檔留下帶 --note 的稽核紀錄。",
    )
    .requiredOption("--job <job-id>", "宣稱擁有此 claim 的 job id（本命令的驗證主體）")
    .requiredOption("--project <project-id>", "claim 所屬的 project id")
    .requiredOption("--issue <issue-id>", "claim 所屬的 issue id（admission 檔案名稱的組成部分）")
    .requiredOption("--note <text>", "稽核用途的復原原因說明（必填，原文寫入 claim 檔）")
    .action(
      (options: {
        readonly job: string;
        readonly project: string;
        readonly issue: string;
        readonly note: string;
      }) =>
        action(state, io, () =>
          handlers.dispatchResolveLegacyClaim({
            jobId: options.job,
            projectId: options.project,
            issueId: options.issue,
            note: options.note,
          }),
        )(),
    );

  dispatch
    .command("auto-merge-resume")
    .description(
      "E116cap：以 stdin 確認字串解除一個因流程外合併而被暫停的專案層級 Auto-merge 旗標" +
        "（該旗標永不自動解除，唯一的解除方式）。專案原本就未暫停時，回報" +
        " already_active，不視為錯誤。",
    )
    .requiredOption("--project <project-id>", "被暫停的專案識別碼")
    .action((options: { readonly project: string }) =>
      action(state, io, () => handlers.dispatchAutoMergeResume({ projectId: options.project }))(),
    );

  const quota = program.command("quota").description("受控的 provider quota host 操作");
  quota
    .command("canary-confirm")
    .description("以嚴格 stdin JSON 建立一次 Claude-only operator canary attestation")
    .action(action(state, io, handlers.quota.canaryConfirm));
  quota
    .command("canary-status")
    .description("以嚴格 stdin JSON 驗證一次 Claude-only operator canary attestation")
    .action(action(state, io, handlers.quota.canaryStatus));
  quota
    .command("probe-status")
    .description("唯讀觀測官方 Claude／Codex 額度來源，不建立 model turn")
    .addOption(
      new Option("--provider <provider>", "額度來源")
        .choices(["claude", "codex", "all"])
        .makeOptionMandatory(),
    )
    .action((options: Readonly<{ provider: "claude" | "codex" | "all" }>) =>
      action(
        state,
        io,
        () =>
          (handlers.quota.probeStatus ?? defaultQuotaHandlers.probeStatus)?.({
            provider: options.provider,
          }) ?? blocked("quota probe-status"),
      )(),
    );

  program
    .command("ingest")
    .description("接收已由外部 HTTPS Runtime 轉交的 Webhook")
    .addArgument(
      new Command().createArgument("<provider>", "Webhook provider").choices(["github", "linear"]),
    )
    .requiredOption("--headers-file <path>", "含原始 HTTP Headers 的 JSON 檔案")
    .action((provider: "github" | "linear", options: { readonly headersFile: string }) =>
      action(state, io, () => handlers.ingest({ provider, headersFile: options.headersFile }))(),
    );

  program
    .command("reconcile")
    .description("對帳本機狀態、事件與權威服務")
    .addOption(new Option("--all", "對帳所有已註冊專案").conflicts("job"))
    .addOption(new Option("--job <job-id>", "只對帳指定既有 Job").conflicts("all"))
    .action((options: Readonly<{ all?: boolean; job?: string }>) =>
      action(state, io, () => {
        if (options.all === true) return handlers.reconcile({ all: true });
        if (options.job !== undefined) return handlers.reconcile({ jobId: options.job });
        return Promise.resolve({
          state: "rejected" as const,
          message: JSON.stringify({
            operation: "manual_reconcile",
            state: "rejected",
            reason: "scope_required",
          }),
        });
      })(),
    );

  program
    .command("cycle")
    .description("執行一次全域互斥的 Controller 收斂輪次")
    .addOption(new Option("--all", "收斂所有已註冊專案").makeOptionMandatory())
    .action(() => action(state, io, () => handlers.cycle({ all: true }))());

  program
    .command("health")
    .description("顯示 Reconcile 喚醒來源、降級原因與手動路徑")
    .action(action(state, io, handlers.health));

  program
    .command("project")
    .description("讀取指定專案或列出專案摘要")
    .argument("[project-id]", "專案識別碼")
    .action((projectId: string | undefined) =>
      action(state, io, () => handlers.project(projectId === undefined ? {} : { projectId }))(),
    );

  program
    .command("ui")
    .description("啟動按需 localhost 管理介面")
    .action(action(state, io, handlers.ui));

  const registration = program
    .command("registration")
    .description("Registration Setup 與主動 Probe 的最小 CLI 接線");

  const setup = registration.command("setup").description("驅動 Registration Setup 精靈");
  setup
    .command("start")
    .description("以 stdin 確認字串建立 Setup Draft PR")
    .requiredOption("--project <project-id>", "專案識別碼")
    .option("--draft <path>", "覆寫預設 host draft 檔路徑")
    .action((options: { readonly project: string; readonly draft?: string }) =>
      action(state, io, () =>
        handlers.registration.setupStart({
          projectId: options.project,
          ...(options.draft === undefined ? {} : { draftPath: options.draft }),
        }),
      )(),
    );
  setup
    .command("status")
    .description("讀取目前 Setup 狀態（唯讀）")
    .requiredOption("--project <project-id>", "專案識別碼")
    .action((options: { readonly project: string }) =>
      action(state, io, () => handlers.registration.setupStatus({ projectId: options.project }))(),
    );
  setup
    .command("resume")
    .description("重新整理／恢復進行中的 Setup 流程")
    .requiredOption("--project <project-id>", "專案識別碼")
    .action((options: { readonly project: string }) =>
      action(state, io, () => handlers.registration.setupResume({ projectId: options.project }))(),
    );
  setup
    .command("refresh")
    .description(
      "重新讀取 CI／agent-team/review 證據；條件達成時發布 Linear／PR 稽核留言並推進到待核可狀態" +
        "（唯一能離開 ci_waiting 的命令；不合併、不啟用可信設定，合併仍須 approve 的 stdin 確認字串把關）",
    )
    .requiredOption("--project <project-id>", "專案識別碼")
    .action((options: { readonly project: string }) =>
      action(state, io, () => handlers.registration.setupRefresh({ projectId: options.project }))(),
    );
  setup
    .command("approve")
    .description("以 stdin 確認字串核可並 SQUASH merge Setup PR")
    .requiredOption("--project <project-id>", "專案識別碼")
    .option("--draft <path>", "覆寫預設 host draft 檔路徑")
    .action((options: { readonly project: string; readonly draft?: string }) =>
      action(state, io, () =>
        handlers.registration.setupApprove({
          projectId: options.project,
          ...(options.draft === undefined ? {} : { draftPath: options.draft }),
        }),
      )(),
    );

  const probe = registration.command("probe").description("驅動 O006 主動 Registration Probe");
  probe
    .command("run")
    .description("以 stdin 確認字串觸發一次完整 Full Revalidation")
    .requiredOption("--project <project-id>", "專案識別碼")
    .action((options: { readonly project: string }) =>
      action(state, io, () => handlers.registration.probeRun({ projectId: options.project }))(),
    );
  probe
    .command("status")
    .description("讀取目前 Probe 執行狀態（唯讀）")
    .requiredOption("--project <project-id>", "專案識別碼")
    .action((options: { readonly project: string }) =>
      action(state, io, () => handlers.registration.probeStatus({ projectId: options.project }))(),
    );

  const systemd = program.command("systemd").description("管理 Agent Team 的 systemd user timer");
  const dryRunOptions = (command: Command): Command =>
    command
      .option("--dry-run", "只輸出預覽，不寫入檔案或呼叫 systemd")
      .option("--preview", "--dry-run 的別名");

  dryRunOptions(
    systemd
      .command("install")
      .description("驗證並安全安裝五分鐘 reconcile timer")
      .action((options: Readonly<{ dryRun?: boolean; preview?: boolean }>) =>
        action(state, io, () =>
          handlers.systemd({
            action: "install",
            dryRun: options.dryRun === true || options.preview === true,
          }),
        )(),
      ),
  );

  dryRunOptions(
    systemd
      .command("uninstall")
      .description("只移除兩個可確認為 Agent Team 所有的 units")
      .action((options: Readonly<{ dryRun?: boolean; preview?: boolean }>) =>
        action(state, io, () =>
          handlers.systemd({
            action: "uninstall",
            dryRun: options.dryRun === true || options.preview === true,
          }),
        )(),
      ),
  );

  systemd
    .command("status")
    .description("顯示 unit ownership、timer 與 Runtime preflight 狀態")
    .action(() => action(state, io, () => handlers.systemd({ action: "status" }))());

  return program;
}

export async function runCli(
  metadata: PackageMetadata,
  argv: readonly string[],
  handlers: CliHandlers = defaultCliHandlers,
  io: CliIo = defaultIo,
): Promise<number> {
  const state: CliExecutionState = { exitCode: cliExitCodes.success };
  const program = createProgram(metadata, handlers, io, state);
  const overrideExits = (command: Command): void => {
    command.exitOverride();
    command.commands.forEach(overrideExits);
  };
  overrideExits(program);
  if (argv.length === 0) {
    program.outputHelp();
    return cliExitCodes.success;
  }
  const argvRejection =
    controllerCycleArgvRejection(argv) ??
    operatorCanaryArgvRejection(argv) ??
    quotaProbeArgvRejection(argv);
  if (argvRejection !== undefined) {
    state.exitCode = outcomeExitCode(argvRejection);
    renderOutcome(argvRejection, io);
    return state.exitCode;
  }
  try {
    await program.parseAsync([...argv], { from: "user" });
    return state.exitCode;
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode === 0 ? cliExitCodes.success : cliExitCodes.usage;
    }
    io.writeErr("CLI command failed unexpectedly.\n");
    return cliExitCodes.failure;
  }
}
