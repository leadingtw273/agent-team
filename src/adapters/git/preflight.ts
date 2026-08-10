import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { GitPort, GitWorkingTreeChange, GitWorktree } from "../../application/ports/index.js";
import type { ReadOptions } from "../../application/ports/common.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import {
  changeRegionSchema,
  repositoryRelativePathSchema,
  type ChangeRegion,
} from "../../domain/project/index.js";
import { RepositorySecretScanner } from "../../infrastructure/redaction/repository-secret-scanner.js";

const defaultMaximumScanBytes = 5 * 1024 * 1024;
const jobIdPattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:/@+-]{0,254}$/u;

export type GitPreflightFinding =
  | Readonly<{ code: "outside_declared_region"; path: string }>
  | Readonly<{ code: "unexpected_untracked"; path: string }>
  | Readonly<{ code: "preexisting_staged_change"; path: string }>
  | Readonly<{ code: "unsafe_symlink"; path: string }>
  | Readonly<{ code: "suspected_secret"; path: string }>
  | Readonly<{ code: "unscannable_file"; path: string }>
  | Readonly<{ code: "overlapping_job_change"; path: string; otherJobId: string }>
  | Readonly<{ code: "gitattributes_modified"; path: string }>;

/** C015m: `git add`/`git diff`/etc. select clean/process filters and diff drivers by consulting
 * whichever `.gitattributes` files are present in the tree -- a provider-writable `.gitattributes`
 * is therefore a config-driven code-execution surface in its own right if a trusted repository's
 * config ever defines an executable filter/diff driver (see C015m's Phase 1/Phase 2 review for the
 * full rationale). This ticket's policy is the simplest safe one: reject *any* change to *any*
 * `.gitattributes` file (root or per-directory) unconditionally, regardless of `declaredRegions` --
 * a legitimate task that genuinely needs to change attributes is rare enough that fail-closed here
 * is an acceptable, disclosed limitation, not a silent gap. */
function isGitAttributesPath(path: string): boolean {
  return path === ".gitattributes" || path.endsWith("/.gitattributes");
}

export interface ConcurrentGitJob {
  readonly jobId: string;
  readonly changes: readonly GitWorkingTreeChange[];
}

export interface GitPreflightRequest {
  readonly worktree: GitWorktree;
  readonly declaredRegions?: readonly ChangeRegion[];
  readonly expectedUntrackedPaths?: readonly string[];
  readonly concurrentJobs?: readonly ConcurrentGitJob[];
  readonly knownSecrets?: readonly string[];
}

export interface GitPreflightReport {
  readonly headSha: string;
  readonly allowed: boolean;
  readonly scopeVerified: boolean;
  readonly changedPaths: readonly string[];
  readonly findings: readonly GitPreflightFinding[];
}

export interface GitPreflightOptions {
  readonly maximumScanBytes?: number;
}

function failure<Value>(): Result<Value, DomainError> {
  return err(domainError("external_failure"));
}

function validPath(path: string): boolean {
  const parsed = repositoryRelativePathSchema.safeParse(path);
  return parsed.success && parsed.data === path;
}

function touchedPaths(change: GitWorkingTreeChange): readonly string[] {
  return change.previousPath === undefined ? [change.path] : [change.previousPath, change.path];
}

function regionContains(region: ChangeRegion, path: string): boolean {
  return (
    region.path === path || (region.coverage === "subtree" && path.startsWith(`${region.path}/`))
  );
}

function inside(root: string, candidate: string): boolean {
  return candidate.startsWith(`${root}${sep}`);
}

function compareFindings(left: GitPreflightFinding, right: GitPreflightFinding): number {
  const leftKey = `${left.path}\0${left.code}\0${"otherJobId" in left ? left.otherJobId : ""}`;
  const rightKey = `${right.path}\0${right.code}\0${"otherJobId" in right ? right.otherJobId : ""}`;
  return leftKey.localeCompare(rightKey);
}

function validRequest(request: GitPreflightRequest): boolean {
  if (
    request.declaredRegions !== undefined &&
    (request.declaredRegions.length === 0 ||
      request.declaredRegions.some((region) => {
        const parsed = changeRegionSchema.safeParse(region);
        return !parsed.success || parsed.data.path !== region.path;
      }))
  ) {
    return false;
  }
  const expected = request.expectedUntrackedPaths ?? [];
  if (
    expected.length > 100_000 ||
    new Set(expected).size !== expected.length ||
    expected.some((path) => !validPath(path))
  ) {
    return false;
  }
  const jobs = request.concurrentJobs ?? [];
  if (
    jobs.length > 100 ||
    new Set(jobs.map((job) => job.jobId)).size !== jobs.length ||
    jobs.some(
      (job) =>
        !jobIdPattern.test(job.jobId) ||
        job.changes.length > 100_000 ||
        job.changes.some((change) => touchedPaths(change).some((path) => !validPath(path))),
    )
  ) {
    return false;
  }
  const secrets = request.knownSecrets ?? [];
  return (
    secrets.length <= 1_000 &&
    secrets.every((secret) => secret.length >= 4 && secret.length <= 100_000)
  );
}

export class GitPreflight {
  readonly #maximumScanBytes: number;

  constructor(
    readonly git: GitPort,
    options: GitPreflightOptions = {},
  ) {
    const configured = options.maximumScanBytes ?? defaultMaximumScanBytes;
    this.#maximumScanBytes =
      Number.isSafeInteger(configured) && configured > 0 && configured <= 100 * 1024 * 1024
        ? configured
        : defaultMaximumScanBytes;
  }

  /**
   * This read-only check must run before staging and rejects any pre-staged path,
   * so it scans the exact worktree bytes that stagePaths will add. The caller's
   * issue lease must prevent file/index changes through the subsequent commit.
   */
  async inspect(
    request: GitPreflightRequest,
    options: ReadOptions = {},
  ): Promise<Result<GitPreflightReport, DomainError>> {
    if (!validRequest(request)) return failure();
    const snapshot = await this.git.inspectWorkingTree(request.worktree, options);
    if (!snapshot.ok) return snapshot;
    let root: string;
    try {
      root = await realpath(request.worktree.path);
    } catch {
      return failure();
    }

    const findings: GitPreflightFinding[] = [];
    const changedPaths = new Set<string>();
    const expectedUntracked = new Set(request.expectedUntrackedPaths ?? []);
    const peerPaths = new Map<string, ReadonlySet<string>>(
      (request.concurrentJobs ?? []).map((job) => [
        job.jobId,
        new Set(job.changes.flatMap(touchedPaths)),
      ]),
    );
    const scanner = new RepositorySecretScanner({ knownSecrets: request.knownSecrets ?? [] });

    for (const change of snapshot.value.changes) {
      for (const path of touchedPaths(change)) {
        changedPaths.add(path);
        if (
          request.declaredRegions !== undefined &&
          !request.declaredRegions.some((region) => regionContains(region, path))
        ) {
          findings.push({ code: "outside_declared_region", path });
        }
        if (isGitAttributesPath(path)) {
          findings.push({ code: "gitattributes_modified", path });
        }
        for (const [otherJobId, paths] of peerPaths) {
          if (paths.has(path)) findings.push({ code: "overlapping_job_change", path, otherJobId });
        }
      }
      if (change.kind === "untracked" && !expectedUntracked.has(change.path)) {
        findings.push({ code: "unexpected_untracked", path: change.path });
      }
      if (change.staged) {
        findings.push({ code: "preexisting_staged_change", path: change.path });
      }
      if (change.kind === "deleted" || change.mode === "submodule") continue;
      if (change.mode === "symlink") {
        if (!(await this.#safeSymlink(root, change.path))) {
          findings.push({ code: "unsafe_symlink", path: change.path });
        }
        continue;
      }
      const scan = await this.#scanFile(root, change.path, scanner);
      if (scan !== undefined) findings.push({ code: scan, path: change.path });
    }

    const orderedFindings = findings.sort(compareFindings);
    return ok({
      headSha: snapshot.value.headSha,
      allowed: orderedFindings.length === 0,
      scopeVerified: request.declaredRegions !== undefined,
      changedPaths: [...changedPaths].sort(),
      findings: orderedFindings,
    });
  }

  async #safeSymlink(root: string, path: string): Promise<boolean> {
    try {
      const linkPath = join(root, path);
      const target = await readlink(linkPath);
      if (isAbsolute(target)) return false;
      const lexicalTarget = resolve(dirname(linkPath), target);
      if (!inside(root, lexicalTarget) || lexicalTarget === join(root, ".git")) return false;
      const resolvedTarget = await realpath(lexicalTarget);
      return inside(root, resolvedTarget) && !inside(join(root, ".git"), resolvedTarget);
    } catch {
      return false;
    }
  }

  async #scanFile(
    root: string,
    path: string,
    scanner: RepositorySecretScanner,
  ): Promise<"suspected_secret" | "unscannable_file" | undefined> {
    try {
      const absolutePath = join(root, path);
      const stat = await lstat(absolutePath);
      if (!stat.isFile() || stat.size > this.#maximumScanBytes) return "unscannable_file";
      const content = await readFile(absolutePath);
      if (content.byteLength !== stat.size) return "unscannable_file";
      const text = content.toString("utf8");
      return scanner.containsSecret(text) ? "suspected_secret" : undefined;
    } catch {
      return "unscannable_file";
    }
  }
}
