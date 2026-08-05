import type { GitPort } from "../ports/git.js";
import type { ReadOptions } from "../ports/common.js";
import { projectSchema, type Project } from "../../domain/project/index.js";
import { Redactor } from "../../infrastructure/redaction/index.js";
import type { RegistrationSetupActivationMarker } from "../registration/setup-model.js";
import {
  serializeTrustedProjectConfig,
  trustedProjectConfigSchema,
  type TrustedProjectConfig,
} from "./schema.js";

export const trustedProjectConfigPath = ".agent-team/project.json";
export const maximumTrustedProjectConfigBytes = 1024 * 1024;

export type TrustedProjectRejectionReason =
  | "invalid_registry_entry"
  | "trusted_config_missing"
  | "trusted_config_unavailable"
  | "trusted_config_invalid"
  | "secret_in_trusted_config"
  | "project_id_mismatch"
  | "default_branch_mismatch"
  | "platform_mismatch"
  | "activation_missing"
  | "activation_unavailable"
  | "activation_invalid"
  | "registry_conflict";

export type TrustedProjectLoadResult =
  | Readonly<{
      state: "ready";
      project: Project;
      config: TrustedProjectConfig;
      revisionSha: string;
    }>
  | Readonly<{
      state: "rejected";
      project?: Project;
      reason: TrustedProjectRejectionReason;
    }>;

export type TrustedProjectGitPort = Pick<GitPort, "readTextFileAtRevision">;
export interface TrustedProjectActivationPort {
  read(
    projectId: Project["id"],
    options?: ReadOptions,
  ): Promise<
    | Readonly<{ ok: true; value: RegistrationSetupActivationMarker | undefined }>
    | Readonly<{ ok: false; error: unknown }>
  >;
}

function equalRecord(
  left: Readonly<Record<string, string>>,
  right: Readonly<Record<string, string>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

export class TrustedProjectConfigLoader {
  constructor(
    readonly git: TrustedProjectGitPort,
    readonly activation?: TrustedProjectActivationPort,
  ) {}

  async load(projectInput: Project, options: ReadOptions = {}): Promise<TrustedProjectLoadResult> {
    const project = projectSchema.safeParse(projectInput);
    if (!project.success) {
      return Object.freeze({ state: "rejected", reason: "invalid_registry_entry" });
    }
    const file = await this.git.readTextFileAtRevision(
      {
        rootPath: project.data.localRepositoryPath,
        revision: `refs/heads/${project.data.defaultBranch}`,
        path: trustedProjectConfigPath,
        maxBytes: maximumTrustedProjectConfigBytes,
      },
      options,
    );
    if (!file.ok) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason:
          file.error.code === "not_found" ? "trusted_config_missing" : "trusted_config_unavailable",
      });
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(file.value.revisionSha)) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "trusted_config_unavailable",
      });
    }
    if (
      file.value.path !== trustedProjectConfigPath ||
      file.value.byteLength !== Buffer.byteLength(file.value.content, "utf8") ||
      file.value.byteLength > maximumTrustedProjectConfigBytes
    ) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "trusted_config_unavailable",
      });
    }
    if (new Redactor().redactText(file.value.content) !== file.value.content) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "secret_in_trusted_config",
      });
    }
    let json: unknown;
    try {
      json = JSON.parse(file.value.content) as unknown;
    } catch {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "trusted_config_invalid",
      });
    }
    const config = trustedProjectConfigSchema.safeParse(json);
    if (!config.success) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "trusted_config_invalid",
      });
    }
    if (config.data.projectId !== project.data.id) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "project_id_mismatch",
      });
    }
    if (config.data.defaultBranch !== project.data.defaultBranch) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "default_branch_mismatch",
      });
    }
    if (
      !equalRecord(config.data.platforms.workManagement, project.data.workManagement) ||
      !equalRecord(config.data.platforms.sourceControl, project.data.sourceControl)
    ) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "platform_mismatch",
      });
    }
    const serialized = serializeTrustedProjectConfig(config.data);
    if (!serialized.ok) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "trusted_config_invalid",
      });
    }
    if (this.activation === undefined) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "activation_missing",
      });
    }
    const activated = await this.activation.read(project.data.id, options);
    if (!activated.ok) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "activation_unavailable",
      });
    }
    const marker = activated.value;
    const digest = /^[0-9a-f]{64}$/u;
    const sha = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
    if (marker === undefined) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "activation_missing",
      });
    }
    const rawMarker = marker as unknown as Readonly<Record<string, unknown>>;
    const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:@+-]{0,220}$/u;
    const expectedMarkerKeys = [
      "approvalReferenceDigest",
      "approvalSource",
      "approvalNonceDigest",
      "auditReceiptsDigest",
      "authoritativeRevision",
      "authorityDigest",
      "changeRequestId",
      "configDigest",
      "defaultBranch",
      "gateEvidenceDigest",
      "linearAuditIssueId",
      "mergeCommitSha",
      "projectId",
      "repository",
      "schemaVersion",
      "setupHeadSha",
      "setupSessionId",
      "source",
    ].sort();
    if (
      Object.keys(rawMarker).sort().join("\0") !== expectedMarkerKeys.join("\0") ||
      rawMarker["schemaVersion"] !== 1 ||
      rawMarker["source"] !== "source_control_default_branch" ||
      marker.projectId !== project.data.id ||
      marker.repository !== project.data.sourceControl.repository ||
      marker.defaultBranch !== project.data.defaultBranch ||
      marker.configDigest !== serialized.value.contentDigest ||
      !sha.test(marker.setupHeadSha) ||
      !sha.test(marker.mergeCommitSha) ||
      !sha.test(marker.authoritativeRevision) ||
      marker.mergeCommitSha.toLowerCase() !== marker.authoritativeRevision.toLowerCase() ||
      !identifier.test(marker.setupSessionId) ||
      !identifier.test(marker.changeRequestId) ||
      !identifier.test(marker.linearAuditIssueId) ||
      !digest.test(marker.gateEvidenceDigest) ||
      !digest.test(marker.auditReceiptsDigest) ||
      !digest.test(marker.approvalReferenceDigest) ||
      !digest.test(marker.authorityDigest) ||
      !digest.test(marker.approvalNonceDigest) ||
      (rawMarker["approvalSource"] !== "local_ui" &&
        rawMarker["approvalSource"] !== "current_user_conversation")
    ) {
      return Object.freeze({
        state: "rejected",
        project: project.data,
        reason: "activation_invalid",
      });
    }
    return Object.freeze({
      state: "ready",
      project: project.data,
      config: config.data,
      revisionSha: file.value.revisionSha,
    });
  }
}
