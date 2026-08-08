import { describe, expect, it } from "vitest";

import { parseInstant } from "../../src/domain/foundation/index.js";
import { issueSchema, type Issue } from "../../src/domain/project/index.js";
import {
  canonicalSerialize,
  canonicalVisualManifest,
  compareReviewIdentity,
  createDiffDigest,
  createRequirementSnapshot,
  createReviewIdentity,
  evidenceDigestOf,
  effectiveTreeDiffSchema,
  type CanonicalVisualManifestInput,
  type EffectiveTreeChange,
  type GitFileMode,
} from "../../src/domain/review/index.js";

const sha1A = "a".repeat(40);
const sha1B = "b".repeat(40);
const sha1C = "c".repeat(40);

function issue(overrides: Partial<Issue> = {}): Issue {
  return issueSchema.parse({
    schemaVersion: 1,
    id: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    projectId: "project_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    externalId: "ENG-123",
    title: "Review identity",
    goal: "Bind approval to effective changes.",
    acceptanceCriteria: ["Content changes invalidate review."],
    inScope: ["src/domain/review/"],
    outOfScope: ["Git adapter"],
    dependencies: { kind: "none" },
    priority: "high",
    agentRole: "implementer",
    reviewRequirement: "code_review",
    estimatedMinutes: 30,
    constraints: ["Do not hash commit metadata."],
    risks: ["A false-stable digest can merge unreviewed code."],
    changeRegions: [{ path: "src/domain/review", coverage: "subtree" }],
    ...overrides,
  });
}

function instant(value: string) {
  const parsed = parseInstant(value);
  if (!parsed.ok) throw new Error(parsed.error.code);
  return parsed.value;
}

function entry(path: string, objectId: string, mode: GitFileMode = "100644") {
  return { path, mode, objectId: { algorithm: "sha1" as const, value: objectId } };
}

function change(
  path = "src/domain/review/index.ts",
  beforeOid = sha1A,
  afterOid = sha1B,
): EffectiveTreeChange {
  return { before: entry(path, beforeOid), after: entry(path, afterOid) };
}

function valueOf<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error("expected result to succeed");
  return result.value;
}

describe("canonical review serialization", () => {
  it("sorts object keys recursively while preserving array order", () => {
    expect(canonicalSerialize({ z: 1, a: { d: 2, b: 1 }, list: [2, 1] })).toEqual({
      ok: true,
      value: '{"a":{"b":1,"d":2},"list":[2,1],"z":1}',
    });
  });

  it("rejects undefined, non-finite numbers, unsupported prototypes, and cycles", () => {
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    for (const input of [{ missing: undefined }, Number.NaN, new Date(), cyclic]) {
      expect(canonicalSerialize(input)).toMatchObject({
        ok: false,
        error: { code: "invariant_violation" },
      });
    }
  });
});

describe("requirement snapshots", () => {
  it("keeps the digest independent from capture time and object insertion order", () => {
    const first = valueOf(createRequirementSnapshot(issue(), instant("2026-08-04T12:00:00.000Z")));
    const reordered = issueSchema.parse(JSON.parse(JSON.stringify(issue())) as unknown);
    const second = valueOf(
      createRequirementSnapshot(reordered, instant("2026-08-04T12:05:00.000Z")),
    );
    expect(first.requirementsDigest).toBe(second.requirementsDigest);
    expect(first.capturedAt).not.toBe(second.capturedAt);
  });

  it("invalidates the snapshot when an acceptance criterion changes", () => {
    const first = valueOf(createRequirementSnapshot(issue(), instant("2026-08-04T12:00:00.000Z")));
    const changed = valueOf(
      createRequirementSnapshot(
        issue({ acceptanceCriteria: ["Mode changes invalidate review."] }),
        instant("2026-08-04T12:00:00.000Z"),
      ),
    );
    expect(first.requirementsDigest).not.toBe(changed.requirementsDigest);
  });
});

describe("effective tree diff digest", () => {
  it("ignores change ordering", () => {
    const left = [change("a.ts"), change("b.ts", sha1B, sha1C)];
    expect(valueOf(createDiffDigest(left))).toBe(valueOf(createDiffDigest([...left].reverse())));
  });

  it("stays stable across commit metadata, order, rebase, and squash represented by new heads", () => {
    const snapshot = valueOf(
      createRequirementSnapshot(issue(), instant("2026-08-04T12:00:00.000Z")),
    );
    const changes = [change()];
    const candidates = [sha1A, sha1B, sha1C].map((headSha) =>
      valueOf(createReviewIdentity(snapshot, headSha, changes)),
    );
    expect(new Set(candidates.map((candidate) => candidate.diffDigest)).size).toBe(1);
    const [first, second] = candidates;
    if (first === undefined || second === undefined) throw new Error("expected review identities");
    expect(compareReviewIdentity(first, second)).toBe("ci_revalidation");
  });

  it.each([
    ["content", [change()], [change("src/domain/review/index.ts", sha1A, sha1C)]],
    [
      "mode",
      [change()],
      [
        {
          before: entry("src/domain/review/index.ts", sha1A),
          after: entry("src/domain/review/index.ts", sha1B, "100755"),
        },
      ],
    ],
    ["add", [change()], [{ before: null, after: entry("src/domain/review/index.ts", sha1B) }]],
    ["delete", [change()], [{ before: entry("src/domain/review/index.ts", sha1A), after: null }]],
  ] as const)("changes the digest when %s changes", (_name, before, after) => {
    expect(valueOf(createDiffDigest(before))).not.toBe(valueOf(createDiffDigest(after)));
  });

  it("includes a pure rename destination in the digest", () => {
    const firstRename = [{ before: entry("old.ts", sha1A), after: entry("renamed.ts", sha1A) }];
    const secondRename = [{ before: entry("old.ts", sha1A), after: entry("other-name.ts", sha1A) }];
    expect(valueOf(createDiffDigest(firstRename))).not.toBe(
      valueOf(createDiffDigest(secondRename)),
    );
  });

  it("requires a full review when requirements or effective tree content changes", () => {
    const firstSnapshot = valueOf(
      createRequirementSnapshot(issue(), instant("2026-08-04T12:00:00.000Z")),
    );
    const changedSnapshot = valueOf(
      createRequirementSnapshot(
        issue({ goal: "Changed goal" }),
        instant("2026-08-04T12:00:00.000Z"),
      ),
    );
    const approved = valueOf(createReviewIdentity(firstSnapshot, sha1A, [change()]));
    expect(
      compareReviewIdentity(
        approved,
        valueOf(createReviewIdentity(changedSnapshot, sha1B, [change()])),
      ),
    ).toBe("full_review");
    expect(
      compareReviewIdentity(
        approved,
        valueOf(createReviewIdentity(firstSnapshot, sha1B, [change("x.ts")])),
      ),
    ).toBe("full_review");
  });

  it("rejects no-op changes and duplicate before/after paths", () => {
    const same = entry("same.ts", sha1A);
    expect(effectiveTreeDiffSchema.safeParse([{ before: null, after: null }]).success).toBe(false);
    expect(effectiveTreeDiffSchema.safeParse([{ before: same, after: same }]).success).toBe(false);
    expect(
      effectiveTreeDiffSchema.safeParse([
        change("same.ts", sha1A, sha1B),
        change("same.ts", sha1B, sha1C),
      ]).success,
    ).toBe(false);
    expect(
      effectiveTreeDiffSchema.safeParse([
        { before: entry("same.ts", sha1A), after: null },
        { before: null, after: entry("same.ts", sha1B) },
      ]).success,
    ).toBe(false);
  });

  it("rejects malformed Head SHA values", () => {
    const snapshot = valueOf(
      createRequirementSnapshot(issue(), instant("2026-08-04T12:00:00.000Z")),
    );
    expect(createReviewIdentity(snapshot, "not-a-sha", [change()])).toMatchObject({
      ok: false,
      error: { code: "invariant_violation" },
    });
  });
});

describe("review identity v2 — evidence and publication digests", () => {
  const artifactZ = {
    path: "evidence/z.png",
    sha256: "d".repeat(64),
    mediaType: "image/png",
    acceptanceCriteria: ["Second criterion", "First criterion"],
  } as const;
  const artifactA = {
    path: "evidence/a.png",
    sha256: "e".repeat(64),
    mediaType: "image/png",
    acceptanceCriteria: ["Fourth criterion", "Third criterion"],
  } as const;
  const manifest: CanonicalVisualManifestInput = {
    schemaVersion: 1,
    issueId: "issue_018f47d2-77a4-7cc1-8ef2-0123456789ab",
    commitSha: sha1A,
    environment: {
      runner: "playwright",
      operatingSystem: "linux",
      applicationVersion: "1.2.3",
      viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
    },
    artifacts: [artifactZ, artifactA],
  };

  it("canonicalizes visual manifests independently of artifact and criterion input order", () => {
    const reordered: CanonicalVisualManifestInput = {
      ...manifest,
      artifacts: [...manifest.artifacts]
        .reverse()
        .map((artifact) => ({
          ...artifact,
          acceptanceCriteria: [...artifact.acceptanceCriteria].reverse(),
        })),
    };
    expect(canonicalVisualManifest(manifest)).toEqual(canonicalVisualManifest(reordered));
    const digest = evidenceDigestOf(manifest);
    expect(digest.ok).toBe(true);
    if (!digest.ok) return;
    expect(digest.value).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("changes the evidence digest when one artifact SHA-256 or acceptance criterion changes", () => {
    const original = valueOf(evidenceDigestOf(manifest));
    const changedSha = {
      ...manifest,
      artifacts: [{ ...artifactZ, sha256: "f".repeat(64) }, artifactA],
    };
    const changedCriterion = {
      ...manifest,
      artifacts: [
        { ...artifactZ, acceptanceCriteria: ["Changed criterion", "First criterion"] },
        artifactA,
      ],
    };
    expect(valueOf(evidenceDigestOf(changedSha))).not.toBe(original);
    expect(valueOf(evidenceDigestOf(changedCriterion))).not.toBe(original);
  });

  it("keeps diffDigest pure while evidence and publication digests vary", () => {
    const snapshot = valueOf(createRequirementSnapshot(issue(), instant("2026-08-04T12:00:00.000Z")));
    const withoutEvidence = valueOf(createReviewIdentity(snapshot, sha1A, [change()]));
    const withEvidence = valueOf(
      createReviewIdentity(snapshot, sha1A, [change()], {
        visualManifest: manifest,
        publicationDigest: "b".repeat(64),
      }),
    );
    expect(withoutEvidence.diffDigest).toBe(withEvidence.diffDigest);
    expect(withoutEvidence.requirementsDigest).toBe(withEvidence.requirementsDigest);
    expect(withoutEvidence.evidenceDigest).toBeUndefined();
    expect(withoutEvidence.publicationDigest).toBeUndefined();
    expect(withEvidence.evidenceDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(withEvidence.publicationDigest).toBe("b".repeat(64));
  });

  it("requires a full review when only evidence or publication digests differ", () => {
    const snapshot = valueOf(createRequirementSnapshot(issue(), instant("2026-08-04T12:00:00.000Z")));
    const approved = valueOf(
      createReviewIdentity(snapshot, sha1A, [change()], {
        visualManifest: manifest,
        publicationDigest: "b".repeat(64),
      }),
    );
    const evidenceChanged = valueOf(
      createReviewIdentity(snapshot, sha1A, [change()], {
        visualManifest: {
          ...manifest,
          artifacts: [{ ...artifactZ, sha256: "c".repeat(64) }, artifactA],
        },
        publicationDigest: "b".repeat(64),
      }),
    );
    const publicationChanged = valueOf(
      createReviewIdentity(snapshot, sha1A, [change()], {
        visualManifest: manifest,
        publicationDigest: "c".repeat(64),
      }),
    );
    const noEvidence = valueOf(createReviewIdentity(snapshot, sha1A, [change()]));
    expect(compareReviewIdentity(approved, evidenceChanged)).toBe("full_review");
    expect(compareReviewIdentity(approved, publicationChanged)).toBe("full_review");
    expect(compareReviewIdentity(noEvidence, noEvidence)).toBe("unchanged");
  });

  it("rejects malformed publication digests", () => {
    const snapshot = valueOf(createRequirementSnapshot(issue(), instant("2026-08-04T12:00:00.000Z")));
    expect(
      createReviewIdentity(snapshot, sha1A, [change()], { publicationDigest: "not-hex" }),
    ).toMatchObject({ ok: false, error: { code: "invariant_violation" } });
  });
});
