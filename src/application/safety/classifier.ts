import { basename, isAbsolute, relative, resolve } from "node:path";

import type { ProcessSpawnRequest } from "../ports/process.js";
import type {
  DangerousOperationCategory,
  OperationClassification,
  ProjectSafetyPolicy,
} from "./model.js";

const shellExecutables = new Set(["bash", "cmd", "fish", "powershell", "pwsh", "sh", "zsh"]);
const safeReadCommands = new Set([
  "cmp",
  "date",
  "diff",
  "dirname",
  "file",
  "find",
  "head",
  "ls",
  "pwd",
  "rg",
  "sed",
  "sort",
  "stat",
  "tail",
  "test",
  "true",
  "uniq",
  "wc",
  "which",
]);
const projectWriteCommands = new Set(["cp", "mkdir", "mv", "touch"]);
const projectDestructiveCommands = new Set(["rm", "rmdir", "shred", "unlink"]);
const localEnvironmentCommands = new Set([
  "chgrp",
  "chmod",
  "chown",
  "kill",
  "killall",
  "mount",
  "pkill",
  "service",
  "sudo",
  "systemctl",
  "umount",
]);
const packageManagers = new Set(["npm", "pnpm", "yarn"]);
const secretPathPattern =
  /(^|[/\\])(?:\.env(?:\.[^/\\]+)?|\.ssh|\.aws|\.config[/\\]gh[/\\]hosts\.yml|credentials?(?:\.[^/\\]+)?|secrets?(?:\.[^/\\]+)?|id_(?:rsa|ed25519)|[^/\\]+\.(?:key|pem))(?:$|[/\\])/iu;

function executableName(executable: string): string {
  return basename(executable)
    .toLowerCase()
    .replace(/\.exe$/u, "");
}

function dangerous(category: DangerousOperationCategory, summary: string): OperationClassification {
  return Object.freeze({ state: "dangerous", category, summary });
}

function ordinary(summary: string): OperationClassification {
  return Object.freeze({ state: "ordinary", summary });
}

function unknown(command: string): OperationClassification {
  return Object.freeze({ state: "unknown", summary: `無法可靠判讀 ${command} 操作` });
}

function invalidText(values: readonly string[]): boolean {
  return values.some((value) => value.length === 0 || /[\u0000\r\n]/u.test(value));
}

function optionValueArguments(arguments_: readonly string[]): readonly string[] {
  return arguments_.filter((argument) => !argument.startsWith("-"));
}

function pathInsideRoot(path: string, workingDirectory: string, projectRoot: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(workingDirectory, path);
  const fromRoot = relative(resolve(projectRoot), absolute);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
}

function allPathsInsideProject(
  arguments_: readonly string[],
  request: ProcessSpawnRequest,
  policy: ProjectSafetyPolicy,
): boolean {
  const paths = optionValueArguments(arguments_);
  return (
    paths.length > 0 &&
    paths.every((path) => pathInsideRoot(path, request.workingDirectory, policy.projectRoot))
  );
}

function accessesSecret(arguments_: readonly string[]): boolean {
  return arguments_.some((argument) => secretPathPattern.test(argument));
}

function classifyGit(arguments_: readonly string[]): OperationClassification {
  const command = arguments_[0];
  if (command === undefined) return unknown("git");
  if (
    ["clean", "filter-branch", "rebase", "reset"].includes(command) ||
    (command === "branch" &&
      arguments_.some((argument) => ["-D", "-d", "--delete"].includes(argument))) ||
    (command === "checkout" &&
      arguments_.some((argument) => ["--", "-f", "--force"].includes(argument))) ||
    command === "restore" ||
    (command === "switch" &&
      arguments_.some((argument) => ["-C", "--force-create"].includes(argument))) ||
    (command === "worktree" &&
      arguments_.some((argument) => ["move", "prune", "remove"].includes(argument))) ||
    (command === "push" &&
      arguments_.some(
        (argument) =>
          argument === "--delete" ||
          argument === "-f" ||
          argument.startsWith("--force") ||
          argument.startsWith("+") ||
          /^:[^:]/u.test(argument),
      ))
  ) {
    return dangerous("git_destructive", `改寫或刪除 Git 歷史／參照（git ${command}）`);
  }
  if (
    [
      "add",
      "branch",
      "checkout",
      "clone",
      "commit",
      "diff",
      "fetch",
      "log",
      "merge-base",
      "push",
      "rev-parse",
      "show",
      "status",
      "switch",
      "worktree",
    ].includes(command)
  ) {
    return ordinary(`執行受控 Git ${command}`);
  }
  return unknown(`git ${command}`);
}

function classifyGh(arguments_: readonly string[]): OperationClassification {
  const resource = arguments_[0];
  const action = arguments_[1];
  if (resource === undefined) return unknown("gh");
  if (resource === "auth" && action === "token") {
    return dangerous("secret_access", "讀取 GitHub 驗證權杖");
  }
  if (resource === "api") {
    const methodIndex = arguments_.findIndex(
      (argument) => argument === "-X" || argument === "--method",
    );
    const method = methodIndex < 0 ? "GET" : arguments_[methodIndex + 1]?.toUpperCase();
    return method === "GET"
      ? ordinary("讀取 GitHub API")
      : dangerous("external_write", `寫入 GitHub API（${method ?? "未知方法"}）`);
  }
  if (
    (resource === "pr" && ["checks", "diff", "list", "status", "view"].includes(action ?? "")) ||
    (resource === "run" && ["list", "view", "watch"].includes(action ?? "")) ||
    (resource === "workflow" && ["list", "view"].includes(action ?? ""))
  ) {
    return ordinary(`讀取 GitHub ${resource}`);
  }
  if (resource === "pr" && action === "create" && arguments_.includes("--draft")) {
    return ordinary("建立 GitHub Draft PR");
  }
  if (["issue", "pr", "release", "repo", "run", "workflow"].includes(resource)) {
    return dangerous("external_write", `變更 GitHub ${resource} 資源（${action ?? "未知動作"}）`);
  }
  return unknown(`gh ${resource}`);
}

function classifyDeployment(
  command: string,
  arguments_: readonly string[],
): OperationClassification | undefined {
  const action = arguments_[0];
  const actionLabel = action ?? "未知動作";
  if (command === "kubectl") {
    if (
      ["apply", "create", "delete", "edit", "patch", "replace", "scale", "set"].includes(
        action ?? "",
      )
    ) {
      return dangerous("deployment", `變更 Kubernetes 資源（kubectl ${actionLabel}）`);
    }
    if (
      ["api-resources", "cluster-info", "describe", "diff", "get", "logs", "version"].includes(
        action ?? "",
      )
    ) {
      return ordinary(`讀取 Kubernetes 狀態（kubectl ${actionLabel}）`);
    }
    return unknown("kubectl");
  }
  if (command === "terraform") {
    if (["apply", "destroy", "import", "taint", "untaint"].includes(action ?? "")) {
      return dangerous("deployment", `變更基礎設施（terraform ${actionLabel}）`);
    }
    if (["fmt", "output", "plan", "show", "validate", "version"].includes(action ?? "")) {
      return ordinary(`檢查 Terraform（terraform ${actionLabel}）`);
    }
    return unknown("terraform");
  }
  if (command === "helm") {
    if (["install", "rollback", "uninstall", "upgrade"].includes(action ?? "")) {
      return dangerous("deployment", `變更 Helm release（helm ${actionLabel}）`);
    }
    if (
      ["get", "history", "lint", "list", "show", "status", "template", "version"].includes(
        action ?? "",
      )
    ) {
      return ordinary(`讀取或檢查 Helm（helm ${actionLabel}）`);
    }
    return unknown("helm");
  }
  return undefined;
}

function classifyExternal(
  command: string,
  arguments_: readonly string[],
): OperationClassification | undefined {
  if (command === "curl") {
    const hasBody = arguments_.some((argument) =>
      [
        "-d",
        "--data",
        "--data-binary",
        "--data-raw",
        "-F",
        "--form",
        "-T",
        "--upload-file",
      ].includes(argument),
    );
    const methodIndex = arguments_.findIndex(
      (argument) => argument === "-X" || argument === "--request",
    );
    const method = methodIndex < 0 ? "GET" : arguments_[methodIndex + 1]?.toUpperCase();
    return hasBody || !["GET", "HEAD"].includes(method ?? "")
      ? dangerous("external_write", "送出會變更外部服務的 HTTP 請求")
      : ordinary("讀取外部 HTTP 資源");
  }
  if (["scp", "sftp"].includes(command)) {
    return dangerous("external_write", `傳送檔案至外部系統（${command}）`);
  }
  if (command === "stripe") {
    const readOnly = arguments_.some((argument) => ["get", "list", "retrieve"].includes(argument));
    return readOnly
      ? ordinary("讀取 Stripe 資源")
      : dangerous("paid_action", "執行可能產生費用的 Stripe 操作");
  }
  return undefined;
}

export function classifyProcessOperation(
  request: ProcessSpawnRequest,
  policy: ProjectSafetyPolicy,
): OperationClassification {
  const command = executableName(request.executable);
  const arguments_ = request.arguments;
  if (
    command.length === 0 ||
    invalidText([request.executable, request.workingDirectory, ...arguments_]) ||
    !isAbsolute(request.workingDirectory)
  ) {
    return unknown(command || "空白命令");
  }
  if (
    accessesSecret(arguments_) ||
    (["env", "printenv"].includes(command) && arguments_.length === 0)
  ) {
    return dangerous("secret_access", `讀取可能含 Secret 的資料（${command}）`);
  }
  if (shellExecutables.has(command)) return unknown(`${command} 動態指令字串`);
  if (command === "git") return classifyGit(arguments_);
  if (command === "gh") return classifyGh(arguments_);

  const deployment = classifyDeployment(command, arguments_);
  if (deployment !== undefined) return deployment;
  const external = classifyExternal(command, arguments_);
  if (external !== undefined) return external;

  if (projectDestructiveCommands.has(command)) {
    return dangerous(
      allPathsInsideProject(arguments_, request, policy)
        ? "project_destructive"
        : "local_environment",
      allPathsInsideProject(arguments_, request, policy)
        ? `刪除專案內檔案（${command}）`
        : `刪除或修改專案外本機資源（${command}）`,
    );
  }
  if (localEnvironmentCommands.has(command)) {
    return dangerous("local_environment", `變更本機環境或行程（${command}）`);
  }
  if (projectWriteCommands.has(command)) {
    return allPathsInsideProject(arguments_, request, policy)
      ? ordinary(`變更專案 Worktree 內檔案（${command}）`)
      : dangerous("local_environment", `變更專案外本機檔案（${command}）`);
  }
  if (command === "cat") return ordinary("讀取非敏感檔案");
  if (safeReadCommands.has(command)) return ordinary(`執行唯讀工具（${command}）`);
  if (packageManagers.has(command)) {
    const action = arguments_[0];
    const actionLabel = action ?? "未知動作";
    const safeExecTools = new Set(["eslint", "prettier", "tsc", "vitest"]);
    const safeScripts = new Set([
      "build",
      "format:check",
      "lint",
      "test",
      "test:contract",
      "test:integration",
      "typecheck",
    ]);
    if (arguments_.some((argument) => argument === "-g" || argument === "--global")) {
      return dangerous("local_environment", `變更全域套件環境（${command} ${actionLabel}）`);
    }
    return [
      "add",
      "build",
      "ci",
      "format:check",
      "install",
      "lint",
      "remove",
      "test",
      "typecheck",
      "uninstall",
      "update",
    ].includes(action ?? "") ||
      (action === "run" && safeScripts.has(arguments_[1] ?? "")) ||
      (action === "exec" && safeExecTools.has(arguments_[1] ?? ""))
      ? ordinary(`執行專案套件工作（${command} ${actionLabel}）`)
      : unknown(`${command} ${action ?? ""}`.trim());
  }
  if (["claude", "codex", "gemini"].includes(command)) {
    return ordinary(`啟動已配置的 ${command} Provider Job`);
  }
  return unknown(command);
}
