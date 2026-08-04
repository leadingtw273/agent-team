import { describe, expect, it } from "vitest";

import type {
  ChildProcessHandle,
  ProcessPort,
  ProcessSpawnRequest,
} from "../../src/application/ports/index.js";
import {
  classifyProcessOperation,
  evaluateProcessSafety,
  spawnWithSafety,
  type DangerousOperationCategory,
  type ProjectSafetyPolicy,
} from "../../src/application/safety/index.js";
import { ok, parseInstant } from "../../src/domain/foundation/index.js";

const projectRoot = "/tmp/agent-team-project";

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function policy(
  longTermAllowedCategories: readonly DangerousOperationCategory[] = [],
): ProjectSafetyPolicy {
  return {
    projectId: "project-agent-team",
    projectRoot,
    longTermAllowedCategories,
  };
}

function processRequest(
  executable: string,
  arguments_: readonly string[] = [],
): ProcessSpawnRequest {
  return {
    executable,
    arguments: arguments_,
    workingDirectory: `${projectRoot}/worktree`,
    deadlineAt: instant("2026-08-05T00:30:00.000Z"),
    maxOutputBytes: 1_024,
  };
}

function classification(executable: string, arguments_: readonly string[] = []) {
  return classifyProcessOperation(processRequest(executable, arguments_), policy());
}

describe("dangerous operation classifier", () => {
  it.each([
    ["project_destructive", "rm", ["-f", "src/obsolete.ts"]],
    ["project_destructive", "unlink", ["src/obsolete.ts"]],
    ["git_destructive", "git", ["reset", "--hard", "HEAD~1"]],
    ["git_destructive", "git", ["push", "--force-with-lease"]],
    ["git_destructive", "git", ["branch", "-d", "merged-task"]],
    ["git_destructive", "git", ["push", "origin", ":obsolete-task"]],
    ["git_destructive", "git", ["checkout", "-f", "main"]],
    ["git_destructive", "git", ["worktree", "remove", "/tmp/task"]],
    ["local_environment", "kill", ["1234"]],
    ["local_environment", "chmod", ["777", "/etc/hosts"]],
    ["local_environment", "pnpm", ["install", "--global", "typescript"]],
    ["deployment", "kubectl", ["delete", "deployment", "api"]],
    ["deployment", "terraform", ["destroy", "-auto-approve"]],
    ["external_write", "curl", ["-X", "POST", "https://example.test/items"]],
    ["external_write", "scp", ["artifact.zip", "host:/srv/"]],
    ["secret_access", "cat", ["~/.ssh/id_ed25519"]],
    ["secret_access", "gh", ["auth", "token"]],
    ["paid_action", "stripe", ["charges", "create", "--amount", "100"]],
  ] as const)("groups %s operations consistently: %s", (category, executable, arguments_) => {
    expect(classification(executable, arguments_)).toMatchObject({ state: "dangerous", category });
  });

  it.each([
    ["rg", ["TODO", "src"]],
    ["pnpm", ["test"]],
    ["pnpm", ["exec", "vitest", "run"]],
    ["git", ["commit", "-m", "safe change"]],
    ["git", ["push", "origin", "task/R008"]],
    ["gh", ["pr", "create", "--draft", "--title", "R008"]],
    ["kubectl", ["get", "pods"]],
    ["terraform", ["plan"]],
    ["curl", ["https://example.test/status"]],
    ["curl", ["-X", "GET", "https://example.test/status"]],
    ["cp", ["src/a.ts", "src/b.ts"]],
  ] as const)("allows bounded ordinary workflow operations: %s", (executable, arguments_) => {
    expect(classification(executable, arguments_)).toMatchObject({ state: "ordinary" });
  });

  it("fails closed for shell strings, unsupported commands, malformed input, and ambiguous subcommands", () => {
    expect(classification("bash", ["-lc", "rm -rf src"])).toMatchObject({ state: "unknown" });
    expect(classification("mystery-tool", ["do-something"])).toMatchObject({ state: "unknown" });
    expect(classification("git", ["update-ref", "refs/heads/main", "deadbeef"])).toMatchObject({
      state: "unknown",
    });
    expect(classification("kubectl", ["plugin-action"])).toMatchObject({ state: "unknown" });
    expect(classification("pnpm", ["run", "destroy-production"])).toMatchObject({
      state: "unknown",
    });
    expect(classification("rg", ["bad\nargument"])).toMatchObject({ state: "unknown" });
  });

  it("distinguishes project worktree paths from local-environment paths", () => {
    expect(classification("rm", ["src/file.ts"])).toMatchObject({
      state: "dangerous",
      category: "project_destructive",
    });
    expect(classification("rm", ["/etc/hosts"])).toMatchObject({
      state: "dangerous",
      category: "local_environment",
    });
    expect(classification("mv", ["src/file.ts", "/tmp/outside.ts"])).toMatchObject({
      state: "dangerous",
      category: "local_environment",
    });
  });
});

describe("project safety policy and pre-process guard", () => {
  it("pauses a dangerous category until it is approved", () => {
    const decision = evaluateProcessSafety(
      { process: processRequest("rm", ["src/file.ts"]), purpose: "移除淘汰檔案" },
      policy(),
    );
    expect(decision).toMatchObject({
      state: "pause",
      reason: "dangerous_operation_approval_required",
      classification: { category: "project_destructive", summary: "刪除專案內檔案（rm）" },
    });
  });

  it("executes a project-long-term category but still requires an audit record", () => {
    const decision = evaluateProcessSafety(
      { process: processRequest("rm", ["src/file.ts"]), purpose: "移除淘汰檔案" },
      policy(["project_destructive"]),
    );
    expect(decision).toMatchObject({
      state: "execute",
      authorization: "project_long_term",
      auditRequired: true,
    });
  });

  it("never lets a long-term category or invalid policy authorize an unknown operation", () => {
    const unknownDecision = evaluateProcessSafety(
      { process: processRequest("bash", ["-lc", "echo dynamic"]), purpose: "執行動態流程" },
      policy([
        "project_destructive",
        "git_destructive",
        "local_environment",
        "deployment",
        "external_write",
        "secret_access",
        "paid_action",
      ]),
    );
    expect(unknownDecision).toMatchObject({ state: "pause", reason: "unknown_operation" });

    const invalidPolicy = evaluateProcessSafety(
      { process: processRequest("rg", ["TODO"]), purpose: "搜尋" },
      { ...policy(), projectRoot: "relative/path" },
    );
    expect(invalidPolicy).toMatchObject({ state: "pause", reason: "invalid_policy" });
  });

  it("does not call ProcessPort for paused operations", async () => {
    let spawnCalls = 0;
    const handle = { pid: 1234 } as ChildProcessHandle;
    const port: ProcessPort = {
      spawn: () => {
        spawnCalls += 1;
        return Promise.resolve(ok(handle));
      },
    };
    const paused = await spawnWithSafety(
      port,
      { process: processRequest("rm", ["src/file.ts"]), purpose: "移除檔案" },
      policy(),
    );
    expect(paused).toMatchObject({ state: "paused" });
    expect(spawnCalls).toBe(0);

    const allowed = await spawnWithSafety(
      port,
      { process: processRequest("rm", ["src/file.ts"]), purpose: "移除檔案" },
      policy(["project_destructive"]),
    );
    expect(allowed).toMatchObject({ state: "process_result", result: { ok: true } });
    expect(spawnCalls).toBe(1);
  });
});
