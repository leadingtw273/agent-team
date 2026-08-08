/**
 * C015a acceptance remediation (observation 4): `dispatchOnce` (src/cli/dispatch/composition.ts)
 * used to map a genuine Linear discovery failure onto the *engine's own*
 * `DispatcherResult` shape (`kind:"blocked", reason:"invalid_runtime_input"`) -- conflating an
 * external-call fault (Linear read failed) with the engine rejecting malformed input it was
 * actually handed. That misleads whoever reads the CLI's JSON output into debugging the wrong
 * layer. `dispatchOnce` now returns a discriminated `DispatchOnceOutcome` with a distinct
 * `outcome:"discovery_failed"` case for exactly this, which this test pins down: (a) the
 * discovery failure surfaces under its own fixed reason, never `invalid_runtime_input`; (b) the
 * engine's `Dispatcher` is never even constructed -- the lease/job ports are provably untouched.
 */
import { describe, expect, it } from "vitest";

import { dispatchOnce, type DispatchCompositionReady } from "../../src/cli/dispatch/composition.js";
import { InMemoryIssueAdmissionStore } from "../../src/cli/dispatch/ephemeral-ports.js";
import { LeaseCoordinator, type LeaseRepository } from "../../src/application/leases/index.js";
import type { JobRepository } from "../../src/application/dispatch/index.js";
import type { FileJobRepository } from "../../src/infrastructure/jobs/index.js";
import type { ProjectRegistrySnapshot } from "../../src/application/projects/index.js";
import { trustedProjectConfigSchema } from "../../src/application/projects/index.js";
import { domainError, err, ok } from "../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../src/domain/project/index.js";
import type { ModelRoutingConfig } from "../../src/application/routing/index.js";
import type { LinearDiscoveryReadModel } from "../../src/adapters/dispatch/linear-discovery.js";
import type { LinearReadModel } from "../../src/adapters/linear/read.js";

const projectId = "project_018f47d2-77a4-7cc1-8ef2-0123456789ab";

function project(): Project {
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId,
    displayName: "Sandbox",
    localRepositoryPath: "/tmp/sandbox",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "team-1", projectId: "linear-proj-1" },
    sourceControl: { provider: "github", repository: "owner/sandbox" },
  });
}

function trustedConfigFixture() {
  const projectValue = project();
  return trustedProjectConfigSchema.parse({
    schemaVersion: 1,
    projectId,
    defaultBranch: "main",
    platforms: {
      workManagement: projectValue.workManagement,
      sourceControl: projectValue.sourceControl,
    },
    projectRules: [],
    roleInstructions: {},
    commands: { quality: [{ executable: "pnpm", arguments: ["test"] }], visualReview: [] },
  });
}

function registry(): ProjectRegistrySnapshot {
  return {
    ready: [
      {
        state: "ready",
        project: project(),
        config: trustedConfigFixture(),
        revisionSha: "a".repeat(40),
      },
    ],
    rejected: [],
  };
}

const routingConfig: ModelRoutingConfig = { schemaVersion: 1, routes: [] };

/** Never expected to be called -- proves the engine is never even constructed when discovery
 * fails (a `Dispatcher` would call `leases.acquire`/`jobs.create`, not `readAll`/`transact`
 * directly, but asserting these never fire at all is the simplest possible tripwire). */
class NeverCalledLeaseRepository implements LeaseRepository {
  called = false;
  readAll() {
    this.called = true;
    return Promise.resolve(ok([]));
  }
  transact() {
    this.called = true;
    return Promise.reject(new Error("must never be called: discovery failed first"));
  }
}

/** `readAll`/`update` (C015c item 2's own additional requirement on
 * `DispatchCompositionReady.jobs`) are never reachable here either -- discovery fails before
 * `dispatchOnce` (this file's own subject) ever touches `jobs` at all. */
class NeverCalledJobRepository implements JobRepository {
  called = false;
  create(): ReturnType<JobRepository["create"]> {
    this.called = true;
    return Promise.reject(new Error("must never be called: discovery failed first"));
  }

  readAll(): ReturnType<FileJobRepository["readAll"]> {
    this.called = true;
    return Promise.reject(new Error("must never be called: discovery failed first"));
  }

  update(): ReturnType<FileJobRepository["update"]> {
    this.called = true;
    return Promise.reject(new Error("must never be called: discovery failed first"));
  }
}

/** Never expected to be called -- discovery fails before `dispatchOnce` ever reaches the
 * capability probe, so this stub only needs to satisfy the type. */
class NeverCalledProcessPort {
  spawn(): ReturnType<import("../../src/application/ports/index.js").ProcessPort["spawn"]> {
    return Promise.reject(new Error("must never be called: discovery failed first"));
  }
}

function readyComposition(readModel: LinearDiscoveryReadModel): DispatchCompositionReady {
  return {
    leases: new NeverCalledLeaseRepository(),
    jobs: new NeverCalledJobRepository(),
    registry: registry(),
    routingConfig,
    discovery: {
      teamId: "team-1",
      linearProjectId: "linear-proj-1",
      readModel: readModel as unknown as LinearReadModel,
      // Never exercised: this fixture only feeds `dispatchOnce` (discovery -> dispatch), well
      // before `LifecyclePipeline` (C015c item 5) would ever consult a mutation client.
      mutationClient: {} as never,
      // E102-5: never exercised for the identical reason -- see `mutationClient` above.
      linearTransport: {} as never,
    },
    project: project(),
    trustedConfig: trustedConfigFixture(),
    claude: {
      config: { executable: "claude", models: ["opus"], account: "default" },
      process: new NeverCalledProcessPort(),
    },
  };
}

describe("dispatchOnce discovery-failure mapping (C015a observation 4)", () => {
  it("reports outcome:'discovery_failed' with the propagated error, not the engine's invalid_runtime_input", async () => {
    const failure = domainError("external_failure");
    const failingReadModel: LinearDiscoveryReadModel = {
      readContext: () => Promise.resolve(err(failure)),
      listIssueIdsInState: () => Promise.resolve(ok([])),
      readIssue: () => Promise.resolve(err(failure)),
    };
    const ready = readyComposition(failingReadModel);
    const leases = ready.leases as NeverCalledLeaseRepository;
    const jobs = ready.jobs as NeverCalledJobRepository;

    const outcome = await dispatchOnce(
      ready,
      {
        leases: new LeaseCoordinator(ready.leases),
        jobs: ready.jobs,
        // Discovery fails before dispatchOnce would ever reach admission claiming -- an
        // ephemeral, never-persisted store is enough to satisfy the port shape here.
        admission: new InMemoryIssueAdmissionStore(),
      },
      "holder-1",
    );

    expect(outcome).toEqual({ outcome: "discovery_failed", error: failure });
    expect(leases.called).toBe(false);
    expect(jobs.called).toBe(false);
  });
});
