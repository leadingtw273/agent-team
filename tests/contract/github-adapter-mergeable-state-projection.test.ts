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
 */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
 */
async function fakeGhRunningRealJq(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-fake-gh-jq-"));
  temporaryDirectories.push(root);
  const executable = join(root, "gh");
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
printf '%s' "$FAKE_GH_RAW_PR" | jq -c "$jq_expr"
`,
    "utf8",
  );
  await chmod(executable, 0o755);
  return executable;
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

async function getChangeRequestViaRealJq(
  rawPr: Readonly<Record<string, unknown>>,
): ReturnType<GitHubAdapter["getChangeRequest"]> {
  const executable = await fakeGhRunningRealJq();
  const adapter = new GitHubAdapter(
    new GhTransport({ executable, environment: { FAKE_GH_RAW_PR: JSON.stringify(rawPr) } }),
  );
  return adapter.getChangeRequest({ project, changeRequestId: "42" });
}

describe("GitHubAdapter.getChangeRequest: real jq execution of the production mergeStateStatus projection", () => {
  it('projects a concrete "behind" mergeable_state through the real jq engine (happy path, proves this is the same string production actually runs)', async () => {
    const result = await getChangeRequestViaRealJq(rawPullRequest({ mergeable_state: "behind" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mergeStateStatus).toBe("behind");
  });

  it('projects an explicit "unknown" mergeable_state as the legitimate transient it is, not a failure', async () => {
    const result = await getChangeRequestViaRealJq(rawPullRequest({ mergeable_state: "unknown" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.mergeStateStatus).toBe("unknown");
  });

  it('C015y decision B: a missing mergeable_state field fails closed (schema rejects null) instead of silently degrading to "unknown" -- the exact broad-fallback bug this ticket removes', async () => {
    const raw = rawPullRequest();
    delete (raw as Record<string, unknown>)["mergeable_state"];
    const result = await getChangeRequestViaRealJq(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");
  });

  it('C015y decision B: an unrecognized new mergeable_state value fails closed (schema rejects it) rather than silently degrading to "unknown"', async () => {
    const result = await getChangeRequestViaRealJq(
      rawPullRequest({ mergeable_state: "has_hooks" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");
  });

  it('an explicit null mergeable_state also fails closed, distinctly from the legitimate string "unknown"', async () => {
    const result = await getChangeRequestViaRealJq(rawPullRequest({ mergeable_state: null }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("external_failure");
  });
});
