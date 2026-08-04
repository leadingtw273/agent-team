import { chmod, mkdir } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";

export const privateDirectoryMode = 0o700;
export const projectDirectoryMode = 0o755;

export interface AgentTeamUserLayout {
  readonly root: string;
  readonly config: string;
  readonly secrets: string;
  readonly state: {
    readonly root: string;
    readonly jobs: string;
    readonly events: string;
    readonly checkpoints: string;
    readonly inbox: string;
    readonly leases: string;
    readonly quota: string;
    readonly locks: string;
  };
}

export interface AgentTeamProjectLayout {
  readonly repositoryRoot: string;
  readonly trustedConfig: string;
}

export function createAgentTeamUserLayout(homeDirectory: string): AgentTeamUserLayout {
  if (!isAbsolute(homeDirectory)) throw new Error("home_directory_must_be_absolute");
  const root = join(resolve(homeDirectory), ".agent-team");
  const stateRoot = join(root, "state");
  return Object.freeze({
    root,
    config: join(root, "config"),
    secrets: join(root, "secrets"),
    state: Object.freeze({
      root: stateRoot,
      jobs: join(stateRoot, "jobs"),
      events: join(stateRoot, "events"),
      checkpoints: join(stateRoot, "checkpoints"),
      inbox: join(stateRoot, "inbox"),
      leases: join(stateRoot, "leases"),
      quota: join(stateRoot, "quota"),
      locks: join(stateRoot, "locks"),
    }),
  });
}

export function createAgentTeamProjectLayout(repositoryRoot: string): AgentTeamProjectLayout {
  if (!isAbsolute(repositoryRoot)) throw new Error("repository_root_must_be_absolute");
  return Object.freeze({
    repositoryRoot: resolve(repositoryRoot),
    trustedConfig: join(resolve(repositoryRoot), ".agent-team"),
  });
}

async function ensureDirectory(directory: string, mode: number): Promise<void> {
  await mkdir(directory, { recursive: true, mode });
  await chmod(directory, mode);
}

export async function ensureUserLayout(
  layout: AgentTeamUserLayout,
): Promise<Result<void, DomainError>> {
  try {
    await Promise.all(
      [
        layout.root,
        layout.config,
        layout.secrets,
        layout.state.root,
        layout.state.jobs,
        layout.state.events,
        layout.state.checkpoints,
        layout.state.inbox,
        layout.state.leases,
        layout.state.quota,
        layout.state.locks,
      ].map((directory) => ensureDirectory(directory, privateDirectoryMode)),
    );
    return ok(undefined);
  } catch {
    return err(domainError("external_failure"));
  }
}

export async function ensureProjectLayout(
  layout: AgentTeamProjectLayout,
): Promise<Result<void, DomainError>> {
  try {
    await ensureDirectory(layout.trustedConfig, projectDirectoryMode);
    return ok(undefined);
  } catch {
    return err(domainError("external_failure"));
  }
}
