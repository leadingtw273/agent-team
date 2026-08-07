/**
 * C015b unit tests: `FailClosedToolDecisionAdapter` (src/cli/dispatch/tool-decision.ts) --
 * proves it always responds `{response:"decline", pause:true}` regardless of what R008's
 * classifier says about the payload (ordinary/dangerous/unrecognizable), per the decision
 * layer's explicit instruction that this ticket has no UI approval flow and must never
 * auto-approve anything.
 */
import { describe, expect, it } from "vitest";

import { FailClosedToolDecisionAdapter } from "../../src/cli/dispatch/tool-decision.js";
import type { ProjectSafetyPolicy } from "../../src/application/safety/index.js";
import {
  parseIdentifier,
  parseInstant,
  type Identifier,
  type Instant,
} from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";
import { jobSchema, emptyAttemptCounters, type Job } from "../../src/domain/jobs/index.js";

function id<Scope extends string>(scope: Scope, value: string): Identifier<Scope> {
  const parsed = parseIdentifier(scope, value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function instant(value: string): Instant {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

const now = instant("2026-08-07T12:00:00.000Z");
const projectId = id("project", "project_018f47d2-77a4-7cc1-8ef2-0123456789ab");

function project(): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

function job(): Job {
  return jobSchema.parse({
    schemaVersion: 1,
    id: id("job", "job_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
    projectId,
    issueId: id("issue", "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab"),
    createdAt: now,
    watchdogExtensionGranted: false,
    attempts: emptyAttemptCounters(),
  });
}

function policy(longTermAllowedCategories: readonly string[] = []): ProjectSafetyPolicy {
  return {
    projectId,
    projectRoot: "/tmp/sandbox",
    longTermAllowedCategories:
      longTermAllowedCategories as ProjectSafetyPolicy["longTermAllowedCategories"],
  };
}

function toolRequest(tool: string, payload: Readonly<Record<string, unknown>>) {
  return Object.freeze({
    kind: "tool_request" as const,
    observedAt: now,
    requestId: "req-1",
    tool,
    payload,
  });
}

describe("FailClosedToolDecisionAdapter", () => {
  it("declines and pauses even when the payload looks ordinary", async () => {
    const adapter = new FailClosedToolDecisionAdapter(() => policy());
    const result = await adapter.decide(toolRequest("Bash", { command: "ls -la" }), {
      job: job(),
      project: project(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.response).toBe("decline");
    expect(result.value.pause).toBe(true);
    expect(result.value.summary).toContain("ordinary");
  });

  it("declines and pauses when the payload looks dangerous", async () => {
    const adapter = new FailClosedToolDecisionAdapter(() => policy());
    const result = await adapter.decide(toolRequest("Bash", { command: "rm -rf /tmp/sandbox" }), {
      job: job(),
      project: project(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.response).toBe("decline");
    expect(result.value.pause).toBe(true);
    expect(result.value.summary).toContain("dangerous");
  });

  it("declines and pauses even when the dangerous category is long-term allowed for this project", async () => {
    // The whole point of "不得自動核可": even if a category were pre-approved for ordinary
    // process spawning elsewhere, a provider tool_request in this ticket's scope still never
    // auto-approves.
    const adapter = new FailClosedToolDecisionAdapter(() => policy(["project_destructive"]));
    const result = await adapter.decide(toolRequest("Bash", { command: "rm -rf /tmp/sandbox" }), {
      job: job(),
      project: project(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.response).toBe("decline");
    expect(result.value.pause).toBe(true);
  });

  it("declines and pauses when the payload cannot be classified at all", async () => {
    const adapter = new FailClosedToolDecisionAdapter(() => policy());
    const result = await adapter.decide(toolRequest("WebFetch", { url: "https://example.com" }), {
      job: job(),
      project: project(),
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.response).toBe("decline");
    expect(result.value.pause).toBe(true);
    expect(result.value.summary).toContain("無法辨識");
  });
});
