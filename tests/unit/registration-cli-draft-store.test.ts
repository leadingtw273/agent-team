/**
 * O009 decision #4: the Setup draft comes exclusively from a host-local JSON file (default
 * `${AGENT_TEAM_HOME}/config/registration/<projectId>.draft.json`, `--draft <path>` overridable),
 * validated against the existing zod schemas, with extra top-level fields rejected. The CLI must
 * never populate this from a request/network payload -- there is no such code path here at all.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  defaultRegistrationDraftPath,
  loadHostRegistrationSetupDraft,
} from "../../src/cli/registration/draft-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agent-team-o009-draft-"));
  roots.push(value);
  return value;
}

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";

function validDraftJson(overrides: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    project: {
      schemaVersion: 1,
      id: projectId,
      displayName: "Sandbox",
      localRepositoryPath: "/tmp/sandbox-repo",
      defaultBranch: "main",
      workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-project-1" },
      sourceControl: { provider: "github", repository: "owner/sandbox" },
    },
    config: {
      schemaVersion: 1,
      projectId,
      defaultBranch: "main",
      platforms: {
        workManagement: {
          provider: "linear",
          containerId: "team-1",
          projectId: "linear-project-1",
        },
        sourceControl: { provider: "github", repository: "owner/sandbox" },
      },
      projectRules: ["Run quality checks."],
      roleInstructions: { implementer: ["Stay in scope."] },
      commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
    },
    linearAuditIssueId: "LINEAR-AUDIT-1",
    ...overrides,
  });
}

describe("defaultRegistrationDraftPath", () => {
  it("resolves under ${AGENT_TEAM_HOME}/config/registration/<projectId>.draft.json", () => {
    expect(defaultRegistrationDraftPath("/home/user/.agent-team", "proj-1")).toBe(
      "/home/user/.agent-team/config/registration/proj-1.draft.json",
    );
  });
});

describe("loadHostRegistrationSetupDraft", () => {
  it("loads and validates a well-formed draft file", async () => {
    const directory = await root();
    const filePath = join(directory, "draft.json");
    await writeFile(filePath, validDraftJson(), "utf8");

    const result = await loadHostRegistrationSetupDraft(filePath, projectId);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.project.id).toBe(projectId);
      expect(result.value.linearAuditIssueId).toBe("LINEAR-AUDIT-1");
    }
  });

  it("rejects a missing draft file", async () => {
    const directory = await root();
    const result = await loadHostRegistrationSetupDraft(join(directory, "missing.json"), projectId);
    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("rejects a draft file with an extra top-level field", async () => {
    const directory = await root();
    const filePath = join(directory, "draft.json");
    await writeFile(filePath, validDraftJson({ unexpectedField: "leaked" }), "utf8");

    const result = await loadHostRegistrationSetupDraft(filePath, projectId);

    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("rejects a draft file whose project.id does not match the requested --project", async () => {
    const directory = await root();
    const filePath = join(directory, "draft.json");
    await writeFile(filePath, validDraftJson(), "utf8");

    const result = await loadHostRegistrationSetupDraft(
      filePath,
      "project_018f47d2-77a4-7cc1-8ef2-0123456789ff",
    );

    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("rejects a draft file with an invalid config (fails the existing strict zod schema)", async () => {
    const directory = await root();
    const filePath = join(directory, "draft.json");
    const draft = JSON.parse(validDraftJson()) as Record<string, unknown>;
    (draft["config"] as Record<string, unknown>)["extraField"] = "leaked";
    await writeFile(filePath, JSON.stringify(draft), "utf8");

    const result = await loadHostRegistrationSetupDraft(filePath, projectId);

    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("rejects malformed JSON", async () => {
    const directory = await root();
    const filePath = join(directory, "draft.json");
    await writeFile(filePath, "{ not valid json", "utf8");

    const result = await loadHostRegistrationSetupDraft(filePath, projectId);

    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });

  it("rejects a directory passed as the draft path", async () => {
    const directory = await root();
    const sub = join(directory, "a-directory");
    await mkdir(sub);

    const result = await loadHostRegistrationSetupDraft(sub, projectId);

    expect(result).toEqual({ ok: false, reason: "missing_or_invalid" });
  });
});
