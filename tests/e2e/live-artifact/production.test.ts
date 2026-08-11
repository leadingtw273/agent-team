import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureProductionLiveArtifact } from "./production.js";
import {
  createLocalHomeFixture,
  fixtureExternalIssueId,
  fixtureGit,
  fixtureGithub,
  fixtureJobId,
  fixtureLinear,
  fixtureProjectId,
  fixtureProvenance,
  fixtureReviewerBody,
  fixtureReviewHtmlUrl,
} from "./fixtures.js";

const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("T11 official production capture path", () => {
  it("captures only independently collected, green four-authority evidence", async () => {
    const home = await createLocalHomeFixture();
    const root = await mkdtemp(join(tmpdir(), "agent-team-t09-output-"));
    roots.push(home, root);
    const fixture = fixtureProvenance();
    const provenance = {
      source: fixture.source,
      producerTask: fixture.producerTask,
      caseId: fixture.caseId,
      runDigest: fixture.runDigest,
      agentTeamRevision: fixture.agentTeamRevision,
      startedAt: fixture.startedAt,
    };
    const result = await captureProductionLiveArtifact(
      {
        provenance,
        projectId: fixtureProjectId,
        expectedLinearIssueId: fixtureExternalIssueId,
        expectedCanaryJobId: fixtureJobId,
        repository: "owner/repository",
        pullRequestNumber: 42,
        agentTeamHome: home,
        artifactRoot: root,
        artifactFileName: "capture.json",
      },
      {
        linear: { read: () => Promise.resolve({ state: "present", value: fixtureLinear() }) },
        github: { read: () => Promise.resolve({ state: "present", value: fixtureGithub() }) },
        git: { read: () => Promise.resolve({ state: "present", value: fixtureGit() }) },
        githubComments: {
          requestJson: () =>
            Promise.resolve({
              ok: true as const,
              value: {
                count: 1,
                comments: [{ htmlUrl: fixtureReviewHtmlUrl, body: fixtureReviewerBody() }],
              },
            }),
        } as never,
      },
    );
    expect(result).toEqual({ state: "captured" });
    const artifact = JSON.parse(await readFile(join(root, "capture.json"), "utf8")) as {
      provenance: { capturedAt: string };
      authorities: { local: { evidence: { leases: { observedAt: string } } } };
    };
    expect(Date.parse(artifact.authorities.local.evidence.leases.observedAt)).toBeLessThanOrEqual(
      Date.parse(artifact.provenance.capturedAt),
    );
  });
});
