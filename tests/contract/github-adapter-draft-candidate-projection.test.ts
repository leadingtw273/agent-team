/**
 * C015z decision (Q1, P0-1): `GitHubAdapter.createDraftChangeRequest`'s idempotent-reuse path
 * calls GitHub's *list* endpoint (`GET /repos/{owner}/{repo}/pulls`) to check for an already-open
 * draft PR for the same base/head before ever attempting to create one. Before this ticket, that
 * call's `--jq` projection embedded the exact same `changeRequestProjection` string the *detail*
 * endpoints (`GET /pulls/{n}`, `POST /pulls`, `PATCH /pulls/{n}`) use -- but GitHub's list endpoint
 * returns the `pull-request-simple` shape, which has **no** `mergeable`/`mergeable_state` field at
 * all (confirmed via a read-only `gh api` probe against this very repo: `has_mergeable:false,
 * has_mergeable_state:false,mergeable_state_value:null`). Once C015y made `mergeStateStatus`
 * schema-required, every list-endpoint response started failing schema validation
 * (`external_failure`) -- silently breaking the idempotent-reuse path in production the instant an
 * open draft PR already existed for the target base/head (E101's own most-travelled retry path).
 *
 * `tests/contract/github-adapter.test.ts`'s own idempotent-reuse test never caught this: it feeds
 * an already-projected fixture straight to a `ScriptedTransport`, never executing the real `--jq`
 * string at all -- exactly the gap `github-adapter-mergeable-state-projection.test.ts` closed for
 * the detail-endpoint projection. This file closes the equivalent gap for the *list* projection,
 * reusing that file's fake-`gh`-running-real-`jq` technique, extended to drive `gh` through *two*
 * sequential calls with two different raw payloads: a list-shaped `pull-request-simple` array (no
 * `mergeable_state`) for the list call, then a full `pull-request` object for the follow-up detail
 * call `createDraftChangeRequest` always makes once a candidate matches (see adapter.ts's own
 * `draftCandidateSchema`/`draftCandidateProjection` headers for why that second call is
 * structural, not incidental).
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
 * A fake `gh` that discriminates the *list* call from every other call (detail `GET /pulls/{n}`,
 * `POST /pulls` create, `PATCH /pulls/{n}`) by the shape of the `--jq` string itself, not the HTTP
 * method (both the list `GET` and the create `POST` pass an explicit `--method` -- only the
 * *projection string's own shape* reliably tells them apart): `draftCandidateProjection`
 * (adapter.ts) always starts with `[` (it projects an array); every detail-shaped projection
 * (`changeRequestProjection`) always starts with `{` (a single object). Whichever raw fixture
 * matches is piped through the real `jq` binary using that exact string.
 */
async function fakeGhForListThenDetail(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-team-fake-gh-list-jq-"));
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
case "$jq_expr" in
  \\[*) raw="$FAKE_GH_RAW_LIST" ;;
  *) raw="$FAKE_GH_RAW_DETAIL" ;;
esac
printf '%s' "$raw" | jq -c "$jq_expr"
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

const command = {
  project,
  title: "A008 fixture",
  body: "Acceptance evidence",
  baseBranch: "main",
  headBranch: "task/fixture",
} as const;
const mutation = { idempotencyKey: "attempt-1" } as const;

/**
 * A realistic *raw* `gh api repos/.../pulls?...` **list** payload -- GitHub's real
 * `pull-request-simple` shape: has `title`/`body`/`draft`/`base`/`head` like the detail shape, but
 * genuinely **no** `mergeable`/`mergeable_state` key at all (not `null` -- entirely absent, exactly
 * matching this repo's own read-only `gh api` probe evidence).
 */
function rawPullRequestSimpleListEntry(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    node_id: "PR_node_fixture",
    number: 42,
    html_url: "https://github.com/owner/repository/pull/42",
    state: "open",
    merged_at: null,
    draft: true,
    title: command.title,
    body: command.body,
    base: { ref: command.baseBranch, sha: "2".repeat(40) },
    head: { ref: command.headBranch, sha: "0123456789abcdef0123456789abcdef01234567" },
    auto_merge: null,
    updated_at: "2026-08-06T12:34:56Z",
    ...overrides,
    // Deliberately no `mergeable`/`mergeable_state` key -- never set to `null`, absent outright.
  };
}

/** The full `pull-request` shape the follow-up detail call (`GET /pulls/{n}`) returns. */
function rawPullRequestDetail(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    node_id: "PR_node_fixture",
    number: 42,
    html_url: "https://github.com/owner/repository/pull/42",
    state: "open",
    merged_at: null,
    draft: true,
    title: command.title,
    body: command.body,
    base: { ref: command.baseBranch, sha: "2".repeat(40) },
    head: { ref: command.headBranch, sha: "0123456789abcdef0123456789abcdef01234567" },
    mergeable: true,
    mergeable_state: "clean",
    auto_merge: null,
    updated_at: "2026-08-06T12:34:56Z",
    ...overrides,
  };
}

async function createDraftChangeRequestViaRealJq(
  rawList: readonly Readonly<Record<string, unknown>>[],
  rawDetail: Readonly<Record<string, unknown>>,
): ReturnType<GitHubAdapter["createDraftChangeRequest"]> {
  const executable = await fakeGhForListThenDetail();
  const adapter = new GitHubAdapter(
    new GhTransport({
      executable,
      environment: {
        FAKE_GH_RAW_LIST: JSON.stringify(rawList),
        FAKE_GH_RAW_DETAIL: JSON.stringify(rawDetail),
      },
    }),
  );
  return adapter.createDraftChangeRequest(command, mutation);
}

describe("GitHubAdapter.createDraftChangeRequest: real jq execution of the list (idempotent-reuse) projection", () => {
  it("reuses an already-open draft PR found via the real list-shaped pull-request-simple payload (no mergeable/mergeable_state at all) -- the exact production regression this ticket fixes", async () => {
    const result = await createDraftChangeRequestViaRealJq(
      [rawPullRequestSimpleListEntry()],
      rawPullRequestDetail(),
    );
    // A/B semantics (C015y's own regression, now fixed): before this ticket, a list-shaped
    // response with no `mergeable_state` failed `projectedChangeRequestSchema`'s now-required
    // field, and this call returned `ok:false, code:"external_failure"`. The fix (a narrow,
    // list-only projection with no `mergeStateStatus` field) must make this `ok:true`, reusing the
    // existing draft PR found by the list call, and it must be a *complete* snapshot -- fetched via
    // a follow-up detail call -- never the narrow list shape smuggled out disguised as one.
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.number).toBe(42);
      expect(result.value.draft).toBe(true);
      expect(result.value.mergeStateStatus).toBe("clean");
      expect(result.value.mergeability).toBe("mergeable");
    }
  });

  it("does not attempt to reuse a candidate whose list-shaped title/body no longer matches (still fails closed to conflict, exactly as the full-detail path always did)", async () => {
    const result = await createDraftChangeRequestViaRealJq(
      [rawPullRequestSimpleListEntry({ title: "A different, stale title" })],
      rawPullRequestDetail(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("conflict");
  });

  it("an empty list-shaped response (no existing draft PR) falls through to the create (POST) path, never touching the list projection's narrow schema for the created result", async () => {
    const executable = await fakeGhForListThenDetail();
    const adapter = new GitHubAdapter(
      new GhTransport({
        executable,
        environment: {
          FAKE_GH_RAW_LIST: JSON.stringify([]),
          // Also serves as the POST create response and the follow-up detail read-back -- both go
          // through the `--method` branch's `else` (no `--method GET`), which is exactly what a
          // POST call looks like too (only the list call ever passes `--method GET`).
          FAKE_GH_RAW_DETAIL: JSON.stringify(rawPullRequestDetail()),
        },
      }),
    );
    const result = await adapter.createDraftChangeRequest(command, mutation);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.draft).toBe(true);
      expect(result.value.mergeStateStatus).toBe("clean");
    }
  });
});
