#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const mode = process.argv[2];
const argument = process.argv[3];
const repository = "leadingtw273/agent-team";

function runGh(args) {
  const result = spawnSync("gh", args, { encoding: "utf8" });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function parseJson(text) {
  return text.trim() ? JSON.parse(text) : null;
}

function classifyCapabilityFailure(run) {
  if (run.exitCode === 0) return null;
  if (run.stderr.includes("Upgrade to GitHub Pro or make this repository public")) {
    return "requires_paid_plan_or_public_repo";
  }
  if (run.stderr.includes("HTTP 403")) return "forbidden";
  if (run.stderr.includes("HTTP 404")) return "not_found_or_not_configured";
  return "unknown_error";
}

function runRepoProbe() {
  const repoRun = runGh(["api", `repos/${repository}`]);
  if (repoRun.exitCode !== 0) throw new Error("repository capability probe failed");
  const repo = parseJson(repoRun.stdout);
  const rulesetsRun = runGh(["api", `repos/${repository}/rulesets`]);
  const protectionRun = runGh(["api", `repos/${repository}/branches/main/protection`]);

  return {
    repository: {
      visibility: repo.visibility,
      private: repo.private,
      defaultBranch: repo.default_branch,
      allowAutoMerge: repo.allow_auto_merge,
      deleteBranchOnMerge: repo.delete_branch_on_merge,
      permissions: {
        admin: repo.permissions?.admin === true,
        maintain: repo.permissions?.maintain === true,
        pull: repo.permissions?.pull === true,
        push: repo.permissions?.push === true,
      },
    },
    rulesets: {
      exitCode: rulesetsRun.exitCode,
      available: rulesetsRun.exitCode === 0,
      count: rulesetsRun.exitCode === 0 ? parseJson(rulesetsRun.stdout).length : null,
      failure: classifyCapabilityFailure(rulesetsRun),
    },
    branchProtection: {
      exitCode: protectionRun.exitCode,
      available: protectionRun.exitCode === 0,
      failure: classifyCapabilityFailure(protectionRun),
    },
  };
}

function requireSha(value) {
  if (!/^[0-9a-f]{40}$/u.test(value ?? "")) throw new Error("a full 40-character SHA is required");
  return value;
}

function runStatusProbe() {
  const sha = requireSha(argument);
  const context = "agent-team/spike";
  const post = runGh([
    "api",
    "--method",
    "POST",
    `repos/${repository}/statuses/${sha}`,
    "-f",
    "state=success",
    "-f",
    `context=${context}`,
    "-f",
    "description=S005 isolated commit-status probe",
  ]);
  if (post.exitCode !== 0) throw new Error("commit status POST failed");
  const posted = parseJson(post.stdout);
  const read = runGh(["api", `repos/${repository}/commits/${sha}/status`]);
  if (read.exitCode !== 0) throw new Error("commit status read-back failed");
  const combined = parseJson(read.stdout);
  const matching = combined.statuses?.find((status) => status.context === context);

  return {
    postExitCode: post.exitCode,
    posted: {
      state: posted.state,
      context: posted.context,
      shaMatches: posted.sha === sha,
    },
    readBack: {
      combinedState: combined.state,
      matchingContextFound: matching !== undefined,
      state: matching?.state ?? null,
      shaMatches: combined.sha === sha,
    },
  };
}

function requirePullNumber(value) {
  if (!/^\d+$/u.test(value ?? "")) throw new Error("a pull request number is required");
  return value;
}

function runPullRequestProbe() {
  const number = requirePullNumber(argument);
  const run = runGh([
    "pr",
    "view",
    number,
    "--repo",
    repository,
    "--json",
    "state,isDraft,headRefOid,mergeStateStatus,statusCheckRollup,autoMergeRequest",
  ]);
  if (run.exitCode !== 0) throw new Error("pull request read-back failed");
  const pull = parseJson(run.stdout);
  return {
    state: pull.state,
    isDraft: pull.isDraft,
    headShaPresent: /^[0-9a-f]{40}$/u.test(pull.headRefOid ?? ""),
    mergeStateStatus: pull.mergeStateStatus,
    checks: (pull.statusCheckRollup ?? []).map((check) => ({
      name: check.name ?? check.context ?? null,
      status: check.status ?? null,
      conclusion: check.conclusion ?? check.state ?? null,
    })),
    autoMergeEnabled: pull.autoMergeRequest !== null,
  };
}

function main() {
  if (!new Set(["repo", "status", "pr"]).has(mode)) {
    throw new Error("usage: gh-probe.mjs <repo|status|pr> [sha|pull-number]");
  }
  const result =
    mode === "repo" ? runRepoProbe() : mode === "status" ? runStatusProbe() : runPullRequestProbe();
  console.log(JSON.stringify({ schemaVersion: 1, probe: mode, result }, null, 2));
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
