import { domainError, err } from "../../../src/domain/foundation/index.js";
import type {
  AsyncPortResult,
  GitPort,
  ProcessPort,
  ProviderPort,
  QuotaPort,
  SourceControlPort,
  WorkManagementPort,
} from "../../../src/application/ports/index.js";

export interface AdapterPortBundle {
  readonly workManagement: WorkManagementPort;
  readonly sourceControl: SourceControlPort;
  readonly git: GitPort;
  readonly process: ProcessPort;
  readonly provider: ProviderPort;
  readonly quota: QuotaPort;
}

function unavailable<Value>(): AsyncPortResult<Value> {
  return Promise.resolve(err(domainError("unavailable")));
}

const workManagement = {
  createIssue: unavailable,
  getIssue: unavailable,
  listIssues: unavailable,
  listComments: unavailable,
  setWorkStatus: unavailable,
  setAgentCondition: unavailable,
  appendComment: unavailable,
  uploadArtifact: unavailable,
} satisfies WorkManagementPort;

const sourceControl = {
  getChangeRequest: unavailable,
  createDraftChangeRequest: unavailable,
  getCommitChecks: unavailable,
  getCommitStatuses: unavailable,
  setCommitStatus: unavailable,
  appendChangeRequestComment: unavailable,
  markChangeRequestReady: unavailable,
  enableAutoMerge: unavailable,
  closeChangeRequest: unavailable,
} satisfies SourceControlPort;

const git = {
  inspectRepository: unavailable,
  resolveAuthoritativeBranch: unavailable,
  createWorktree: unavailable,
  inspectWorktree: unavailable,
  inspectWorkingTree: unavailable,
  readTextFileAtRevision: unavailable,
  stagePaths: unavailable,
  getEffectiveTreeDiff: unavailable,
  getStagedTreeDiff: unavailable,
  inspectCommit: unavailable,
  commit: unavailable,
  push: unavailable,
  removeWorktree: unavailable,
} satisfies GitPort;

const process = {
  spawn: unavailable,
} satisfies ProcessPort;

const provider = {
  inspectCapabilities: unavailable,
  start: unavailable,
} satisfies ProviderPort;

const quota = {
  readCached: unavailable,
  refresh: unavailable,
} satisfies QuotaPort;

export function createUnavailableFakeAdapterPorts(): AdapterPortBundle {
  return Object.freeze({ workManagement, sourceControl, git, process, provider, quota });
}

const requiredMethods = {
  workManagement: [
    "createIssue",
    "getIssue",
    "listIssues",
    "listComments",
    "setWorkStatus",
    "setAgentCondition",
    "appendComment",
    "uploadArtifact",
  ],
  sourceControl: [
    "getChangeRequest",
    "createDraftChangeRequest",
    "getCommitChecks",
    "getCommitStatuses",
    "setCommitStatus",
    "appendChangeRequestComment",
    "markChangeRequestReady",
    "enableAutoMerge",
    "closeChangeRequest",
  ],
  git: [
    "inspectRepository",
    "resolveAuthoritativeBranch",
    "createWorktree",
    "inspectWorktree",
    "inspectWorkingTree",
    "readTextFileAtRevision",
    "stagePaths",
    "getEffectiveTreeDiff",
    "commit",
    "push",
    "removeWorktree",
  ],
  process: ["spawn"],
  provider: ["inspectCapabilities", "start"],
  quota: ["readCached", "refresh"],
} as const;

export function missingAdapterPortMethods(bundle: AdapterPortBundle): readonly string[] {
  const missing: string[] = [];
  for (const [portName, methods] of Object.entries(requiredMethods)) {
    const port = bundle[portName as keyof AdapterPortBundle];
    const members = port as unknown as Readonly<Record<string, unknown>>;
    for (const method of methods) {
      if (typeof members[method] !== "function") missing.push(`${portName}.${method}`);
    }
  }
  return missing;
}
