export interface RegistrationSetupApprovalBinding {
  readonly approvalId: string;
  readonly expectedSetupRevision: number;
  readonly setupSessionId: string;
  readonly projectId: string;
  readonly previewDigest: string;
  readonly changeRequestId: string;
  readonly headSha: string;
  readonly requirementsDigest: string;
  readonly diffDigest: string;
}

export type RegistrationSetupApprovalReadModel =
  | Readonly<{ state: "none" }>
  | (RegistrationSetupApprovalBinding &
      Readonly<{
        state: "waiting";
        projectName: string;
        pullRequestUrl: string;
      }>);

export interface RegistrationSetupApprovalUiCommand {
  readonly approvalId: string;
  readonly userConfirmed: true;
  readonly expectedSetupRevision: number;
}

export interface RegistrationSetupApprovalUiUseCase {
  readonly read: () => Promise<RegistrationSetupApprovalReadModel>;
  readonly approve: (
    command: RegistrationSetupApprovalUiCommand,
  ) => Promise<Readonly<{ state: "accepted" | "conflict" | "rejected" }>>;
}
