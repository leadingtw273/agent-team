import { createHash } from "node:crypto";
import { TextDecoder, types } from "node:util";

import { z } from "zod";

import type { ReadOptions } from "../../application/ports/index.js";
import {
  serializeTrustedProjectConfig,
  trustedProjectConfigPath,
  trustedProjectConfigSchema,
} from "../../application/projects/index.js";
import type {
  RegistrationSetupMergedConfigReadBackPort,
  RegistrationSetupMergedConfigReceipt,
} from "../../application/registration/index.js";
import {
  domainError,
  domainErrorDefinitions,
  err,
  ok,
  type DomainError,
  type DomainErrorCode,
  type Result,
} from "../../domain/foundation/index.js";
import { projectSchema } from "../../domain/project/index.js";
import { canonicalSerialize } from "../../domain/review/index.js";
import { Redactor } from "../../infrastructure/redaction/index.js";
import type { GhJsonTransport } from "../github/adapter.js";

const githubShaPattern = /^[0-9a-f]{40}$/u;
const repositoryPattern = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,38}\/[A-Za-z0-9_.-]{1,100}$/u;
const branchPattern = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/u;
const pullRequestNodeIdPattern = /^PR_[A-Za-z0-9_=-]{1,220}$/u;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u;
const lfsPointerPrefix = "version https://git-lfs.github.com/spec/v1\n";

/** Kept well below GitHub's Contents API large-file behavior threshold. */
export const maximumGitHubTrustedConfigBytes = 256 * 1024;
const maximumBase64Bytes = Math.ceil(maximumGitHubTrustedConfigBytes / 3) * 4 + 8 * 1024;

const repositoryProjectionSchema = z
  .object({ repository: z.string().min(1), defaultBranch: z.string().min(1) })
  .strict();
const mergedPullRequestProjectionSchema = z
  .object({
    id: z.string().min(1),
    repository: z.string().min(1),
    number: z.number().int().positive(),
    state: z.enum(["open", "closed", "merged"]),
    merged: z.boolean(),
    baseBranch: z.string().min(1),
    headSha: z.string().regex(githubShaPattern),
    mergeCommitSha: z.string().regex(githubShaPattern).nullable(),
  })
  .strict();
const commitProjectionSchema = z.object({ sha: z.string().regex(githubShaPattern) }).strict();
const compareProjectionSchema = z
  .object({
    status: z.enum(["identical", "ahead", "behind", "diverged"]),
    aheadBy: z.number().int().nonnegative(),
    behindBy: z.number().int().nonnegative(),
    totalCommits: z.number().int().nonnegative(),
    baseCommitSha: z.string().regex(githubShaPattern),
    mergeBaseSha: z.string().regex(githubShaPattern),
    commits: z.array(z.string().regex(githubShaPattern)).max(1_000),
  })
  .strict();
const contentsProjectionSchema = z
  .object({
    type: z.string(),
    path: z.string(),
    sha: z.string().regex(githubShaPattern),
    size: z.number().int().nonnegative().max(maximumGitHubTrustedConfigBytes),
    encoding: z.string(),
    content: z.string().max(maximumBase64Bytes),
    target: z.string().nullable(),
    submoduleGitUrl: z.string().nullable(),
  })
  .strict();

const repositoryProjection = "{repository:.full_name,defaultBranch:.default_branch}";
const mergedPullRequestProjection =
  "{id:.node_id,repository:.base.repo.full_name,number,state,merged:(.merged_at != null),baseBranch:.base.ref,headSha:.head.sha,mergeCommitSha:.merge_commit_sha}";
const mergedPullRequestNodeQuery =
  "query($pullRequestId:ID!){node(id:$pullRequestId){... on PullRequest{id,number,state,merged,baseRefName,headRefOid,mergeCommit{oid},repository{nameWithOwner}}}}";
const mergedPullRequestNodeProjection =
  "{id:.data.node.id,repository:.data.node.repository.nameWithOwner,number:.data.node.number,state:(.data.node.state|ascii_downcase),merged:.data.node.merged,baseBranch:.data.node.baseRefName,headSha:.data.node.headRefOid,mergeCommitSha:(.data.node.mergeCommit.oid // null)}";
const commitProjection = "{sha:.sha}";
const compareProjection =
  "{status,aheadBy:.ahead_by,behindBy:.behind_by,totalCommits:.total_commits,baseCommitSha:.base_commit.sha,mergeBaseSha:.merge_base_commit.sha,commits:[.commits[].sha]}";
const contentsProjection =
  '{type,path,sha,size,encoding:(.encoding // ""),content:(.content // ""),target:(.target // null),submoduleGitUrl:(.submodule_git_url // null)}';

const commandKeys = Object.freeze([
  "project",
  "changeRequestId",
  "expectedHeadSha",
  "defaultBranch",
  "path",
] as const);
const projectKeys = Object.freeze([
  "schemaVersion",
  "id",
  "displayName",
  "localRepositoryPath",
  "defaultBranch",
  "workManagement",
  "sourceControl",
] as const);
const workManagementKeys = Object.freeze(["provider", "containerId", "projectId"] as const);
const sourceControlKeys = Object.freeze(["provider", "repository"] as const);
const successResultKeys = Object.freeze(["ok", "value"] as const);
const errorResultKeys = Object.freeze(["ok", "error"] as const);
const domainErrorKeys = Object.freeze([
  "kind",
  "code",
  "category",
  "message",
  "retryable",
] as const);
const maximumProviderSnapshotNodes = 10_000;

interface ProviderPrimitiveShape {
  readonly kind: "primitive";
}

interface ProviderArrayShape {
  readonly kind: "array";
  readonly element: ProviderSnapshotShape;
}

interface ProviderObjectShape {
  readonly kind: "object";
  readonly fields: Readonly<Record<string, ProviderSnapshotShape>>;
}

type ProviderSnapshotShape = ProviderPrimitiveShape | ProviderArrayShape | ProviderObjectShape;

const providerPrimitiveShape = Object.freeze({ kind: "primitive" } as const);
const repositoryProviderShape = Object.freeze({
  kind: "object",
  fields: Object.freeze({
    repository: providerPrimitiveShape,
    defaultBranch: providerPrimitiveShape,
  }),
} as const);
const pullRequestProviderShape = Object.freeze({
  kind: "object",
  fields: Object.freeze({
    id: providerPrimitiveShape,
    repository: providerPrimitiveShape,
    number: providerPrimitiveShape,
    state: providerPrimitiveShape,
    merged: providerPrimitiveShape,
    baseBranch: providerPrimitiveShape,
    headSha: providerPrimitiveShape,
    mergeCommitSha: providerPrimitiveShape,
  }),
} as const);
const commitProviderShape = Object.freeze({
  kind: "object",
  fields: Object.freeze({ sha: providerPrimitiveShape }),
} as const);
const compareProviderShape = Object.freeze({
  kind: "object",
  fields: Object.freeze({
    status: providerPrimitiveShape,
    aheadBy: providerPrimitiveShape,
    behindBy: providerPrimitiveShape,
    totalCommits: providerPrimitiveShape,
    baseCommitSha: providerPrimitiveShape,
    mergeBaseSha: providerPrimitiveShape,
    commits: Object.freeze({ kind: "array", element: providerPrimitiveShape } as const),
  }),
} as const);
const contentsProviderShape = Object.freeze({
  kind: "object",
  fields: Object.freeze({
    type: providerPrimitiveShape,
    path: providerPrimitiveShape,
    sha: providerPrimitiveShape,
    size: providerPrimitiveShape,
    encoding: providerPrimitiveShape,
    content: providerPrimitiveShape,
    target: providerPrimitiveShape,
    submoduleGitUrl: providerPrimitiveShape,
  }),
} as const);

interface MergedConfigCommandSnapshot {
  readonly project: z.infer<typeof projectSchema>;
  readonly changeRequestId: string;
  readonly expectedHeadSha: string;
  readonly defaultBranch: string;
  readonly path: string;
}

function failure<Value>(): Result<Value, DomainError> {
  return err(domainError("external_failure"));
}

function exactDataRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some((key) => typeof key !== "string")) {
      return undefined;
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        !ownKeys.includes(key)
      ) {
        return undefined;
      }
    }
    return Object.freeze(
      Object.fromEntries(keys.map((key) => [key, descriptors[key]?.value])) as Record<
        string,
        unknown
      >,
    );
  } catch {
    return undefined;
  }
}

interface ProviderSnapshotBudget {
  nodes: number;
}

function snapshotProviderValue(
  value: unknown,
  shape: ProviderSnapshotShape,
  budget: ProviderSnapshotBudget,
  ancestors: WeakSet<object>,
): Result<unknown, DomainError> {
  budget.nodes += 1;
  if (budget.nodes > maximumProviderSnapshotNodes) return failure();
  if (shape.kind === "primitive") {
    if (value === null || typeof value === "boolean") return ok(value);
    if (typeof value === "string") {
      return value.length <= maximumBase64Bytes ? ok(value) : failure();
    }
    if (typeof value === "number") return Number.isFinite(value) ? ok(value) : failure();
    return failure();
  }
  if (typeof value !== "object" || value === null || types.isProxy(value) || ancestors.has(value)) {
    return failure();
  }

  try {
    const prototype = Object.getPrototypeOf(value) as unknown;
    const ownKeys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    ancestors.add(value);
    if (shape.kind === "array") {
      if (!Array.isArray(value)) return failure();
      if (prototype !== Array.prototype) return failure();
      const lengthDescriptor = descriptors["length"];
      const length =
        lengthDescriptor !== undefined && "value" in lengthDescriptor
          ? (lengthDescriptor.value as unknown)
          : undefined;
      if (
        typeof length !== "number" ||
        !Number.isSafeInteger(length) ||
        length < 0 ||
        ownKeys.length !== length + 1
      ) {
        return failure();
      }
      const snapshot: unknown[] = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          return failure();
        }
        const child = snapshotProviderValue(descriptor.value, shape.element, budget, ancestors);
        if (!child.ok) return child;
        snapshot.push(child.value);
      }
      return ok(Object.freeze(snapshot));
    }
    if (Array.isArray(value)) return failure();
    if (prototype !== Object.prototype && prototype !== null) return failure();
    const expectedKeys = Object.keys(shape.fields);
    if (
      ownKeys.length !== expectedKeys.length ||
      ownKeys.some((key) => typeof key !== "string" || !Object.hasOwn(shape.fields, key))
    ) {
      return failure();
    }
    const snapshot = Object.create(null) as Record<string, unknown>;
    for (const key of expectedKeys) {
      const descriptor = descriptors[key];
      const childShape = shape.fields[key];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable ||
        childShape === undefined
      ) {
        return failure();
      }
      const child = snapshotProviderValue(descriptor.value, childShape, budget, ancestors);
      if (!child.ok) return child;
      Object.defineProperty(snapshot, key, {
        configurable: false,
        enumerable: true,
        value: child.value,
        writable: false,
      });
    }
    return ok(Object.freeze(snapshot));
  } catch {
    return failure();
  }
}

function snapshotTransportResult<Output>(
  value: unknown,
  schema: z.ZodType<Output>,
  shape: ProviderSnapshotShape,
): Result<Output, DomainError> {
  const success = exactDataRecord(value, successResultKeys);
  if (success?.["ok"] === true) {
    const snapshot = snapshotProviderValue(success["value"], shape, { nodes: 0 }, new WeakSet());
    if (!snapshot.ok) return snapshot;
    const parsed = schema.safeParse(snapshot.value);
    return parsed.success ? ok(deepFreeze(parsed.data)) : failure();
  }

  const failed = exactDataRecord(value, errorResultKeys);
  if (failed?.["ok"] !== false) return failure();
  const rawError = exactDataRecord(failed["error"], domainErrorKeys);
  if (
    rawError?.["kind"] !== "domain_error" ||
    typeof rawError["code"] !== "string" ||
    typeof rawError["category"] !== "string" ||
    typeof rawError["message"] !== "string" ||
    typeof rawError["retryable"] !== "boolean"
  ) {
    return failure();
  }
  const code = rawError["code"];
  if (!Object.hasOwn(domainErrorDefinitions, code)) return failure();
  const canonical = domainError(code as DomainErrorCode);
  return sameValue(rawError, canonical) ? err(canonical) : failure();
}

function captureOwnRequestJson(value: unknown): GhJsonTransport["requestJson"] | undefined {
  if (typeof value !== "object" || value === null || types.isProxy(value)) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "requestJson");
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      typeof descriptor.value !== "function" ||
      types.isProxy(descriptor.value)
    ) {
      return undefined;
    }
    // eslint-disable-next-line @typescript-eslint/unbound-method -- calling the intrinsic avoids user-controlled `.bind` lookup.
    return Reflect.apply(Function.prototype.bind, descriptor.value, [
      value,
    ]) as GhJsonTransport["requestJson"];
  } catch {
    return undefined;
  }
}

async function safelyRequestJson<Output>(
  requestJson: GhJsonTransport["requestJson"],
  arguments_: readonly string[],
  validator: z.ZodType<Output>,
  shape: ProviderSnapshotShape,
  options: ReadOptions,
): Promise<Result<Output, DomainError>> {
  try {
    const exposedArguments = Object.freeze([...arguments_]);
    const exposedOptions = Object.freeze(
      options.signal === undefined ? {} : { signal: options.signal },
    );
    const response = await requestJson(exposedArguments, z.unknown(), exposedOptions);
    return snapshotTransportResult(response, validator, shape);
  } catch {
    return failure();
  }
}

function deepFreeze<Value>(value: Value): Value {
  if (typeof value !== "object" || value === null) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function snapshotCommand(command: unknown): Result<MergedConfigCommandSnapshot, DomainError> {
  const rawCommand = exactDataRecord(command, commandKeys);
  if (rawCommand === undefined) return failure();
  const rawProject = exactDataRecord(rawCommand["project"], projectKeys);
  if (rawProject === undefined) return failure();
  const rawWorkManagement = exactDataRecord(rawProject["workManagement"], workManagementKeys);
  const rawSourceControl = exactDataRecord(rawProject["sourceControl"], sourceControlKeys);
  if (rawWorkManagement === undefined || rawSourceControl === undefined) return failure();

  const projectInput = {
    schemaVersion: rawProject["schemaVersion"],
    id: rawProject["id"],
    displayName: rawProject["displayName"],
    localRepositoryPath: rawProject["localRepositoryPath"],
    defaultBranch: rawProject["defaultBranch"],
    workManagement: {
      provider: rawWorkManagement["provider"],
      containerId: rawWorkManagement["containerId"],
      projectId: rawWorkManagement["projectId"],
    },
    sourceControl: {
      provider: rawSourceControl["provider"],
      repository: rawSourceControl["repository"],
    },
  };
  const project = projectSchema.safeParse(projectInput);
  const changeRequestId = rawCommand["changeRequestId"];
  const expectedHeadSha = rawCommand["expectedHeadSha"];
  const defaultBranch = rawCommand["defaultBranch"];
  const path = rawCommand["path"];
  if (
    !project.success ||
    !sameValue(project.data, projectInput) ||
    typeof changeRequestId !== "string" ||
    typeof expectedHeadSha !== "string" ||
    typeof defaultBranch !== "string" ||
    typeof path !== "string"
  ) {
    return failure();
  }
  return ok(
    Object.freeze({
      project: deepFreeze(project.data),
      changeRequestId,
      expectedHeadSha,
      defaultBranch,
      path,
    }),
  );
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function validRepository(repository: string): boolean {
  const parts = repository.split("/");
  return repositoryPattern.test(repository) && parts.every((part) => part !== "." && part !== "..");
}

function validBranch(branch: string): boolean {
  return (
    branchPattern.test(branch) &&
    !branch.includes("..") &&
    !branch.includes("//") &&
    !branch.endsWith(".") &&
    !branch.endsWith("/") &&
    !branch.endsWith(".lock")
  );
}

function encodePath(value: string): string {
  return value
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function sameValue(left: unknown, right: unknown): boolean {
  const leftCanonical = canonicalSerialize(left);
  const rightCanonical = canonicalSerialize(right);
  return leftCanonical.ok && rightCanonical.ok && leftCanonical.value === rightCanonical.value;
}

function exactCompareAncestry(
  compare: z.infer<typeof compareProjectionSchema>,
  mergeSha: string,
  defaultTipSha: string,
): boolean {
  if (compare.baseCommitSha !== mergeSha || compare.mergeBaseSha !== mergeSha) return false;
  if (compare.status === "identical") {
    return (
      defaultTipSha === mergeSha &&
      compare.aheadBy === 0 &&
      compare.behindBy === 0 &&
      compare.totalCommits === 0 &&
      compare.commits.length === 0
    );
  }
  if (compare.status !== "ahead" || defaultTipSha === mergeSha) return false;
  return (
    compare.aheadBy > 0 &&
    compare.behindBy === 0 &&
    compare.totalCommits === compare.aheadBy &&
    compare.commits.length === compare.aheadBy &&
    compare.commits.at(-1) === defaultTipSha &&
    new Set(compare.commits).size === compare.commits.length &&
    !compare.commits.includes(mergeSha)
  );
}

function decodeContents(
  contents: z.infer<typeof contentsProjectionSchema>,
): Result<string, DomainError> {
  if (
    contents.type !== "file" ||
    contents.path !== trustedProjectConfigPath ||
    contents.encoding !== "base64" ||
    contents.target !== null ||
    contents.submoduleGitUrl !== null ||
    contents.size === 0 ||
    contents.size > maximumGitHubTrustedConfigBytes ||
    /[^A-Za-z0-9+/=\r\n]/u.test(contents.content)
  ) {
    return failure();
  }
  const normalized = contents.content.replace(/\r?\n/gu, "");
  if (!base64Pattern.test(normalized)) return failure();
  const decoded = Buffer.from(normalized, "base64");
  if (
    decoded.byteLength !== contents.size ||
    decoded.toString("base64") !== normalized ||
    decoded.byteLength > maximumGitHubTrustedConfigBytes
  ) {
    return failure();
  }
  const header = Buffer.from(`blob ${String(decoded.byteLength)}\0`, "utf8");
  const blobSha = createHash("sha1").update(header).update(decoded).digest("hex");
  if (blobSha !== contents.sha) return failure();
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(decoded);
    return content.startsWith(lfsPointerPrefix) ? failure() : ok(content);
  } catch {
    return failure();
  }
}

/** GitHub-only authoritative merged-config read-back; it has no local Git or filesystem path. */
export class GitHubRegistrationMergedConfigReadBackAdapter implements RegistrationSetupMergedConfigReadBackPort {
  readonly #requestJson: GhJsonTransport["requestJson"];

  constructor(transport: GhJsonTransport) {
    const requestJson = captureOwnRequestJson(transport);
    if (requestJson === undefined)
      throw new TypeError("GitHub merged-config read-back transport is required.");
    this.#requestJson = Object.freeze(requestJson);
  }

  async read(
    command: Parameters<RegistrationSetupMergedConfigReadBackPort["read"]>[0],
    options: ReadOptions = {},
  ): Promise<Result<RegistrationSetupMergedConfigReceipt, DomainError>> {
    const captured = snapshotCommand(command);
    if (!captured.ok) return captured;
    const snapshot = captured.value;
    const project = snapshot.project;
    const numericChangeRequestId = /^[1-9][0-9]{0,9}$/u.test(snapshot.changeRequestId);
    const nodeChangeRequestId = pullRequestNodeIdPattern.test(snapshot.changeRequestId);
    const changeRequestNumber = numericChangeRequestId
      ? Number(snapshot.changeRequestId)
      : undefined;
    if (
      project.sourceControl.provider !== "github" ||
      !validRepository(project.sourceControl.repository) ||
      (!numericChangeRequestId && !nodeChangeRequestId) ||
      (numericChangeRequestId && !Number.isSafeInteger(changeRequestNumber)) ||
      !githubShaPattern.test(snapshot.expectedHeadSha) ||
      !validBranch(snapshot.defaultBranch) ||
      snapshot.defaultBranch !== project.defaultBranch ||
      snapshot.path !== trustedProjectConfigPath
    ) {
      return failure();
    }

    let requestJson: GhJsonTransport["requestJson"];
    try {
      requestJson = this.#requestJson;
    } catch {
      return failure();
    }

    let readOptions: ReadOptions;
    try {
      const signal = options.signal;
      readOptions = Object.freeze(signal === undefined ? {} : { signal });
    } catch {
      return failure();
    }

    const repositoryPath = encodePath(project.sourceControl.repository);
    const repositoryArguments = Object.freeze([
      "api",
      `repos/${repositoryPath}`,
      "--method",
      "GET",
      "--jq",
      repositoryProjection,
    ]);
    const repositoryRead = await safelyRequestJson(
      requestJson,
      repositoryArguments,
      repositoryProjectionSchema,
      repositoryProviderShape,
      readOptions,
    );
    if (!repositoryRead.ok) return repositoryRead;

    const pullRequestArguments = Object.freeze(
      numericChangeRequestId
        ? [
            "api",
            `repos/${repositoryPath}/pulls/${snapshot.changeRequestId}`,
            "--method",
            "GET",
            "--jq",
            mergedPullRequestProjection,
          ]
        : [
            "api",
            "graphql",
            "--method",
            "POST",
            "-f",
            `query=${mergedPullRequestNodeQuery}`,
            "-f",
            `pullRequestId=${snapshot.changeRequestId}`,
            "--jq",
            mergedPullRequestNodeProjection,
          ],
    );
    const pullRequestRead = await safelyRequestJson(
      requestJson,
      pullRequestArguments,
      mergedPullRequestProjectionSchema,
      pullRequestProviderShape,
      readOptions,
    );
    if (!pullRequestRead.ok) return pullRequestRead;

    const repository = Object.freeze({ ...repositoryRead.value });
    const pullRequest = Object.freeze({ ...pullRequestRead.value });
    if (
      !sameRepository(repository.repository, project.sourceControl.repository) ||
      repository.defaultBranch !== snapshot.defaultBranch ||
      !sameRepository(pullRequest.repository, project.sourceControl.repository) ||
      (numericChangeRequestId
        ? pullRequest.number !== changeRequestNumber
        : pullRequest.id !== snapshot.changeRequestId) ||
      (pullRequest.state !== "closed" && pullRequest.state !== "merged") ||
      !pullRequest.merged ||
      pullRequest.baseBranch !== snapshot.defaultBranch ||
      pullRequest.headSha !== snapshot.expectedHeadSha ||
      pullRequest.mergeCommitSha === null
    ) {
      return failure();
    }
    const mergeSha = pullRequest.mergeCommitSha;

    const defaultTipArguments = Object.freeze([
      "api",
      `repos/${repositoryPath}/commits/${encodeURIComponent(repository.defaultBranch)}`,
      "--method",
      "GET",
      "--jq",
      commitProjection,
    ]);
    const defaultTipRead = await safelyRequestJson(
      requestJson,
      defaultTipArguments,
      commitProjectionSchema,
      commitProviderShape,
      readOptions,
    );
    if (!defaultTipRead.ok) return defaultTipRead;
    const defaultTipSha = defaultTipRead.value.sha;

    const compareRead = await safelyRequestJson(
      requestJson,
      Object.freeze([
        "api",
        `repos/${repositoryPath}/compare/${mergeSha}...${defaultTipSha}`,
        "--method",
        "GET",
        "--jq",
        compareProjection,
      ]),
      compareProjectionSchema,
      compareProviderShape,
      readOptions,
    );
    if (!compareRead.ok) return compareRead;
    if (!exactCompareAncestry(compareRead.value, mergeSha, defaultTipSha)) return failure();

    const contentsRead = await safelyRequestJson(
      requestJson,
      Object.freeze([
        "api",
        `repos/${repositoryPath}/contents/${encodePath(trustedProjectConfigPath)}`,
        "--method",
        "GET",
        "-f",
        `ref=${mergeSha}`,
        "--jq",
        contentsProjection,
      ]),
      contentsProjectionSchema,
      contentsProviderShape,
      readOptions,
    );
    if (!contentsRead.ok) return contentsRead;
    const decoded = decodeContents(contentsRead.value);
    if (!decoded.ok || new Redactor().redactText(decoded.value) !== decoded.value) return failure();

    let rawConfig: unknown;
    try {
      rawConfig = JSON.parse(decoded.value) as unknown;
    } catch {
      return failure();
    }
    const config = trustedProjectConfigSchema.safeParse(rawConfig);
    if (!config.success) return failure();
    const serialized = serializeTrustedProjectConfig(config.data);
    if (
      !serialized.ok ||
      serialized.value.content !== decoded.value ||
      config.data.projectId !== project.id ||
      config.data.defaultBranch !== project.defaultBranch ||
      !sameValue(config.data.platforms.workManagement, project.workManagement) ||
      !sameValue(config.data.platforms.sourceControl, project.sourceControl)
    ) {
      return failure();
    }

    const confirmedRepositoryRead = await safelyRequestJson(
      requestJson,
      repositoryArguments,
      repositoryProjectionSchema,
      repositoryProviderShape,
      readOptions,
    );
    if (!confirmedRepositoryRead.ok) return confirmedRepositoryRead;
    const confirmedRepository = Object.freeze({ ...confirmedRepositoryRead.value });
    if (
      !sameRepository(confirmedRepository.repository, project.sourceControl.repository) ||
      confirmedRepository.defaultBranch !== repository.defaultBranch ||
      confirmedRepository.defaultBranch !== snapshot.defaultBranch
    ) {
      return failure();
    }
    const confirmedDefaultTipArguments = Object.freeze([
      "api",
      `repos/${repositoryPath}/commits/${encodeURIComponent(confirmedRepository.defaultBranch)}`,
      "--method",
      "GET",
      "--jq",
      commitProjection,
    ]);
    const confirmedDefaultTipRead = await safelyRequestJson(
      requestJson,
      confirmedDefaultTipArguments,
      commitProjectionSchema,
      commitProviderShape,
      readOptions,
    );
    if (!confirmedDefaultTipRead.ok) return confirmedDefaultTipRead;
    if (confirmedDefaultTipRead.value.sha !== defaultTipSha) return failure();

    return ok(
      Object.freeze({
        schemaVersion: 1,
        source: "source_control_default_branch",
        projectId: project.id,
        repository: project.sourceControl.repository,
        changeRequestId: snapshot.changeRequestId,
        setupHeadSha: snapshot.expectedHeadSha,
        mergeCommitSha: mergeSha,
        defaultBranch: snapshot.defaultBranch,
        authoritativeRevision: mergeSha,
        path: snapshot.path,
        configDigest: serialized.value.contentDigest,
        config: deepFreeze(config.data),
      }),
    );
  }
}
