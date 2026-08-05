import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  LocalRegistrationReadOnlyProbeAdapter,
  type CompiledCliCommandRunner,
} from "../../src/adapters/registration/index.js";
import { ok } from "../../src/domain/foundation/index.js";

const execute = promisify(execFile);
const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agent-team-o002-local-"));
  directories.push(directory);
  return directory;
}

async function git(directory: string, arguments_: readonly string[]): Promise<void> {
  await execute("git", [...arguments_], { cwd: directory, windowsHide: true });
}

async function repository(): Promise<string> {
  const directory = await temporaryDirectory();
  await git(directory, ["init", "--initial-branch", "main"]);
  await git(directory, ["config", "user.email", "o002@example.test"]);
  await git(directory, ["config", "user.name", "O002 Test"]);
  await writeFile(join(directory, "README.md"), "# O002\n", "utf8");
  await git(directory, ["add", "README.md"]);
  await git(directory, ["commit", "-m", "initial"]);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

describe("O002 concrete local read-only probes", () => {
  it("inspects a local Git Repository, current Node runtime, and compiled CLI without exposing raw output", async () => {
    const root = await repository();
    const cliPath = resolve(process.cwd(), "dist", "cli", "index.js");
    const currentMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    const invocations: {
      executable: string;
      arguments: readonly string[];
      timeoutMs: number;
    }[] = [];
    const adapter = new LocalRegistrationReadOnlyProbeAdapter({
      repositoryRoot: root,
      compiledCliPath: cliPath,
      requiredNodeMajor: currentMajor,
      now: () => "2026-08-05T12:00:00.000Z",
      cliRunner: Object.freeze({
        run: (input: Parameters<CompiledCliCommandRunner["run"]>[0]) => {
          invocations.push(input);
          return Promise.resolve(ok("0.1.0\n"));
        },
      }),
    });

    const [repositoryProbe, nodeProbe, cliProbe] = await Promise.all([
      adapter.localRepository.inspect(),
      adapter.nodeRuntime.inspect(),
      adapter.compiledCli.inspect(),
    ]);

    expect(repositoryProbe).toMatchObject({
      ok: true,
      value: { evidenceCode: "local_repository_clean" },
    });
    expect(nodeProbe).toMatchObject({
      ok: true,
      value: { evidenceCode: "node_runtime_detected", detectedMajor: currentMajor },
    });
    expect(cliProbe).toMatchObject({
      ok: true,
      value: { evidenceCode: "compiled_cli_version_verified", version: "0.1.0" },
    });
    expect(JSON.stringify(cliProbe)).toContain("0.1.0");
    expect((await stat(cliPath)).isFile()).toBe(true);
    expect(invocations).toEqual([
      expect.objectContaining({
        executable: process.execPath,
        arguments: [cliPath, "--version"],
      }),
    ]);
  });

  it("fails closed when compiled CLI version output carries a credential marker", async () => {
    const root = await temporaryDirectory();
    const cliPath = join(root, "compiled-cli.js");
    const marker = ["github", "_pat_", "abcdefghijklmnopqrstuvwxyz"].join("");
    await writeFile(cliPath, "compiled entrypoint fixture\n", "utf8");
    const adapter = new LocalRegistrationReadOnlyProbeAdapter({
      compiledCliPath: cliPath,
      cliRunner: Object.freeze({
        run: () => Promise.resolve(ok(`${marker} 0.1.0\n`)),
      }),
    });

    const probe = await adapter.compiledCli.inspect();

    expect(probe).toMatchObject({ ok: false, error: { code: "external_failure" } });
    expect(JSON.stringify(probe)).not.toContain(marker);
  });

  it("reports absent configuration as unknown and a non-matching Node major as failed", async () => {
    const adapter = new LocalRegistrationReadOnlyProbeAdapter({
      nodeVersion: () => "23.9.0",
      requiredNodeMajor: 24,
      now: () => "2026-08-05T12:00:00.000Z",
    });

    const [repositoryProbe, nodeProbe, cliProbe] = await Promise.all([
      adapter.localRepository.inspect(),
      adapter.nodeRuntime.inspect(),
      adapter.compiledCli.inspect(),
    ]);

    expect(repositoryProbe).toMatchObject({
      ok: true,
      value: { evidenceCode: "local_repository_unconfigured" },
    });
    expect(nodeProbe).toMatchObject({
      ok: true,
      value: { evidenceCode: "node_runtime_detected", detectedMajor: 23, requiredMajor: 24 },
    });
    expect(cliProbe).toMatchObject({
      ok: true,
      value: { evidenceCode: "compiled_cli_unconfigured" },
    });
  });

  it("rejects repository roots that are symlinks or non-directories before invoking Git", async () => {
    const parent = await temporaryDirectory();
    const target = join(parent, "target");
    const linked = join(parent, "linked");
    const regularFile = join(parent, "repository.txt");
    await mkdir(target);
    await symlink(target, linked, "dir");
    await writeFile(regularFile, "not a directory\n", "utf8");
    let gitCalls = 0;
    const gitAdapter = Object.freeze({
      inspectRepository: () => {
        gitCalls += 1;
        return Promise.resolve(
          ok({ rootPath: target, clean: true, headSha: "unused", branch: "main" }),
        );
      },
    });

    const [symlinkResult, fileResult] = await Promise.all([
      new LocalRegistrationReadOnlyProbeAdapter({
        repositoryRoot: linked,
        git: gitAdapter,
      }).localRepository.inspect(),
      new LocalRegistrationReadOnlyProbeAdapter({
        repositoryRoot: regularFile,
        git: gitAdapter,
      }).localRepository.inspect(),
    ]);

    expect(symlinkResult).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(fileResult).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(gitCalls).toBe(0);
  });

  it("rejects Node version text containing a valid version as only a substring", async () => {
    const adapter = new LocalRegistrationReadOnlyProbeAdapter({
      nodeVersion: () => "prefix 24.0.0 suffix",
      requiredNodeMajor: 24,
    });

    const result = await adapter.nodeRuntime.inspect();

    expect(result).toMatchObject({ ok: false, error: { code: "external_failure" } });
  });
});
