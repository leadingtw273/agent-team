/**
 * C015y decision B: before this ticket, *every* test exercising `GitHubAdapter.getChangeRequest`
 * fed an already-projected fixture straight to a `ScriptedTransport` (see e.g.
 * `tests/contract/github-adapter.test.ts`) -- the real `--jq` string `changeRequestProjection`
 * embeds (adapter.ts) was never actually executed by anything. A field typo, a GitHub API field
 * rename, or a missing field would have silently passed every one of those tests unchanged, while
 * production kept mapping the resulting `null`/`undefined` to `"unknown"` -- BEHIND (and every
 * other real state) would then be silently unobservable, and no gate would ever turn red.
 *
 * This file closes that gap by driving `GitHubAdapter.getChangeRequest` through a *fake `gh`
 * executable* (the same technique `tests/contract/github-transport.test.ts` already established
 * for other `gh` behaviors) that does not hardcode a projected result at all -- it extracts
 * whatever string `GitHubAdapter` actually passes as `--jq` and pipes a realistic *raw* GitHub PR
 * payload through the real system `jq` binary using that exact string. This is the one place in
 * the whole suite that can prove the literal jq expression embedded in adapter.ts, not a
 * hand-copied re-implementation of it, produces the right `mergeStateStatus` (or the right
 * failure) for a given raw payload.
 *
 * C015y decision B also removed the old `if/elif ... else "unknown"` broad fallback from that jq
 * expression -- `mergeStateStatus` is now passed straight through to
 * `projectedChangeRequestSchema`'s existing `z.enum([...])`, which becomes the *only* validation.
 * The four cases below are exactly the three-way breakdown that schema field's own comment
 * describes: an explicit `"unknown"` (legitimate transient, kept), a missing/null field (schema
 * reject), and an unrecognized new value (schema reject) -- plus one concrete `"behind"` case
 * proving the happy path still projects correctly through the real jq engine.
 *
 * C015z decision (P0-4 item 3): every schema-rejection case below used to assert only
 * `error.code === "external_failure"` -- but `GhTransport.requestJson` (transport.ts) maps *both*
 * "jq itself failed to run" (missing binary, a malformed `--jq` string, a nonzero jq exit) and
 * "jq ran fine but the schema then rejected its output" to that exact same code (any nonzero exit
 * from the fake `gh` process is mapped by `mapGhError`, never reaching `schema.safeParse` at all).
 * A jq binary silently absent from `PATH` (or a future accidental syntax break in the projection
 * string) would make every one of these tests pass just as emptily as the pre-C015y broad fallback
 * did. `getChangeRequestViaRealJq` below now also captures the fake `gh` script's own jq
 * sub-process exit code and stderr to sibling files, out-of-band from the `DomainError` the adapter
 * itself returns -- so each rejection case can assert, independently, that jq exited `0` with no
 * stderr (it ran to completion and produced well-formed JSON) *and* that the resulting
 * `DomainError` is still `external_failure` (schema, not jq, rejected it).
 */
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GhTransport, GitHubAdapter } from "../../src/adapters/github/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A fake `gh` that never hardcodes a *projected* result -- it locates the `--jq` argument among
 * `"$@"` and forwards the raw fixture (`$FAKE_GH_RAW_PR`) through the real `jq` binary using that
 * exact string, so whatever `GitHubAdapter` actually constructed is what actually runs.
 *
 * C015z: also redirects the real `jq` sub-process's own stderr to `$FAKE_GH_JQ_STDERR_FILE` and
 * records its own exit code to `$FAKE_GH_JQ_EXIT_FILE` -- both out-of-band from `gh`'s own exit
 * code/stdout, which is all `GhTransport` (transport.ts) ever sees. This is what lets a test assert
 * "jq itself ran to completion, exit 0, no stderr" as evidence *independent of* the `DomainError`
 * code the adapter returns -- proving a rejection is the schema's, never jq's own failure.
 */
async function fakeGhRunningRealJq(): Promise<
  Readonly<{ executable: string; jqExitCodePath: string; jqStderrPath: string }>
> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-fake-gh-jq-"));
  temporaryDirectories.push(root);
  const executable = join(root, "gh");
  const jqExitCodePath = join(root, "jq-exit-code");
  const jqStderrPath = join(root, "jq-stderr");
  await writeFile(
    executable,
    `#!/bin/sh
jq_expr=""
found=0
for arg in "$@"; do
  if [ "$found" = "1" ]; then
    jq_expr="$arg"
    found=0
  fi
  if [ "$arg" = "--jq" ]; then
    found=1
  fi
done
printf '%s' "$FAKE_GH_RAW_PR" | jq -c "$jq_expr" 2>"$FAKE_GH_JQ_STDERR_FILE"
jq_exit_code=$?
printf '%s' "$jq_exit_code" > "$FAKE_GH_JQ_EXIT_FILE"
exit "$jq_exit_code"
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return { executable, jqExitCodePath, jqStderrPath };
}

const project: Project = projectSchema.parse({
  schemaVersion: 1,
  id: "project_12345678-1234-1234-9234-123456789abc",
  displayName: "Fixture",
  localRepositoryPath: "/tmp/fixture",
  defaultBranch: "main",
  workManagement: { provider: "linear", containerId: "team", projectId: "project" },
  sourceControl: { provider: "github", repository: "owner/repository" },
});

/** A realistic *raw* `gh api repos/.../pulls/<n>` payload -- the shape `changeRequestProjection`
 * (adapter.ts) actually reads from, field names and all (`node_id`, `html_url`, `merged_at`,
 * `base.ref`/`base.sha`, `head.ref`/`head.sha`, `mergeable`, `mergeable_state`, `auto_merge`,
 * `updated_at`) -- never the already-projected shape the rest of the suite uses. */
function rawPullRequest(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    node_id: "PR_node_fixture",
    number: 42,
    html_url: "https://github.com/owner/repository/pull/42",
    state: "open",
    merged_at: null,
    draft: false,
    base: { ref: "main", sha: "2".repeat(40) },
    head: { ref: "task/fixture", sha: "0123456789abcdef0123456789abcdef01234567" },
    mergeable: true,
    mergeable_state: "clean",
    auto_merge: null,
    updated_at: "2026-08-06T12:34:56Z",
    ...overrides,
  };
}

async function getChangeRequestViaRealJq(rawPr: Readonly<Record<string, unknown>>): Promise<
  Readonly<{
    result: Awaited<ReturnType<GitHubAdapter["getChangeRequest"]>>;
    jqExitCode: string;
    jqStderr: string;
  }>
> {
  const { executable, jqExitCodePath, jqStderrPath } = await fakeGhRunningRealJq();
  const adapter = new GitHubAdapter(
    new GhTransport({
      executable,
      environment: {
        FAKE_GH_RAW_PR: JSON.stringify(rawPr),
        FAKE_GH_JQ_EXIT_FILE: jqExitCodePath,
        FAKE_GH_JQ_STDERR_FILE: jqStderrPath,
      },
    }),
  );
  const result = await adapter.getChangeRequest({ project, changeRequestId: "42" });
  const [jqExitCode, jqStderr] = await Promise.all([
    readFile(jqExitCodePath, "utf8").catch(() => "<missing: jq never ran>"),
    readFile(jqStderrPath, "utf8").catch(() => "<missing: jq never ran>"),
  ]);
  return { result, jqExitCode, jqStderr };
}

describe("GitHubAdapter.getChangeRequest: real jq execution of the production mergeStateStatus projection", () => {
  it('projects a concrete "behind" mergeable_state through the real jq engine (happy path, proves this is the same string production actually runs)', async () => {
    const { result, jqExitCode, jqStderr } = await getChangeRequestViaRealJq(
      rawPullRequest({ mergeable_state: "behind" }),
    );
    expect(jqExitCode).toBe("0");
    expect(jqStderr).toBe("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mergeStateStatus).toBe("behind");
  });

  it('projects an explicit "unknown" mergeable_state as the legitimate transient it is, not a failure', async () => {
    const { result, jqExitCode, jqStderr } = await getChangeRequestViaRealJq(
      rawPullRequest({ mergeable_state: "unknown" }),
    );
    expect(jqExitCode).toBe("0");
    expect(jqStderr).toBe("");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mergeStateStatus).toBe("unknown");
  });

  it('C015y decision B: a missing mergeable_state field fails closed (schema rejects null) instead of silently degrading to "unknown" -- the exact broad-fallback bug this ticket removes', async () => {
    const raw = rawPullRequest();
    delete (raw as Record<string, unknown>)["mergeable_state"];
    const { result, jqExitCode, jqStderr } = await getChangeRequestViaRealJq(raw);
    // C015z decision (P0-4 item 3): proves jq itself ran to completion (exit 0, no stderr) and
    // produced well-formed JSON -- it is `projectedChangeRequestSchema` rejecting a `null`
    // `mergeStateStatus`, never the jq binary crashing or being absent, that produces this failure.
    expect(jqExitCode).toBe("0");
    expect(jqStderr).toBe("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");
  });

  it('C015y decision B: an unrecognized new mergeable_state value fails closed (schema rejects it) rather than silently degrading to "unknown"', async () => {
    const { result, jqExitCode, jqStderr } = await getChangeRequestViaRealJq(
      rawPullRequest({ mergeable_state: "has_hooks" }),
    );
    expect(jqExitCode).toBe("0");
    expect(jqStderr).toBe("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");
  });

  it('an explicit null mergeable_state also fails closed, distinctly from the legitimate string "unknown"', async () => {
    const { result, jqExitCode, jqStderr } = await getChangeRequestViaRealJq(
      rawPullRequest({ mergeable_state: null }),
    );
    expect(jqExitCode).toBe("0");
    expect(jqStderr).toBe("");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");
  });

  it("if the jq binary itself is missing (or the projection string is malformed), the fake gh script's own jq sub-process fails BEFORE producing any output -- distinct evidence from the schema-rejection cases above, proving this harness can actually tell the two apart", async () => {
    const { executable, jqExitCodePath, jqStderrPath } = await fakeGhRunningRealJq();
    const adapter = new GitHubAdapter(
      new GhTransport({
        executable,
        environment: {
          FAKE_GH_RAW_PR: JSON.stringify(rawPullRequest()),
          FAKE_GH_JQ_EXIT_FILE: jqExitCodePath,
          FAKE_GH_JQ_STDERR_FILE: jqStderrPath,
          // Corrupts jq's own resolution rather than the raw payload -- forces the real `jq`
          // binary itself to fail (unmatched brace is invalid jq syntax), never reaching a
          // well-formed JSON output at all.
          PATH: "/nonexistent-path-to-force-a-real-failure",
        },
      }),
    );
    const result = await adapter.getChangeRequest({ project, changeRequestId: "42" });
    const [jqExitCode, jqStderr] = await Promise.all([
      readFile(jqExitCodePath, "utf8").catch(() => "<missing: jq never ran>"),
      readFile(jqStderrPath, "utf8").catch(() => "<missing: jq never ran>"),
    ]);
    // The shell itself cannot even find `jq` on this corrupted PATH -- a nonzero exit distinct
    // from every schema-rejection case above (which all exit "0", jq having actually run).
    expect(jqExitCode).not.toBe("0");
    expect(jqStderr.toLowerCase()).toContain("not found");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");
  });
});
