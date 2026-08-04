import type { GitPort } from "../ports/git.js";
import type { ReadOptions } from "../ports/common.js";
import { projectSchema, type Project } from "../../domain/project/index.js";
import { Redactor } from "../../infrastructure/redaction/index.js";
import { trustedProjectConfigSchema, type TrustedProjectConfig } from "./schema.js";

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
  constructor(readonly git: TrustedProjectGitPort) {}

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
    return Object.freeze({
      state: "ready",
      project: project.data,
      config: config.data,
      revisionSha: file.value.revisionSha,
    });
  }
}
