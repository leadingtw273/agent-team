/**
 * `getChangeRequest`/`getCommitChecks`/`getCommitStatuses`/`createDraftChangeRequest`/
 * `closeChangeRequest` (src/application/ports/source-control.ts) all require a full `Project`
 * domain object, but only ever read `project.sourceControl.repository` -- every other field is
 * structurally required by `projectSchema` but functionally irrelevant to these calls. This
 * fixed, valid, never-persisted-or-compared placeholder exists purely so `projectSchema.parse`
 * succeeds; its id/displayName/etc. carry no meaning and are never read by anything this harness
 * calls. Originally introduced by E005's evidence collector (ports.ts); E006's seed/reset module
 * needs the exact same placeholder for its own `SourceControlPort` calls, so it is factored out
 * here rather than duplicated.
 */
import { parseIdentifier } from "../../../src/domain/foundation/index.js";
import { projectSchema, type Project } from "../../../src/domain/project/index.js";

export function placeholderProjectFor(repository: string): Project {
  const projectId = parseIdentifier("project", "project_00000000-0000-4000-8000-000000000000");
  if (!projectId.ok) throw new Error("unreachable: fixed placeholder project id is well-formed");
  return projectSchema.parse({
    schemaVersion: 1,
    id: projectId.value,
    displayName: "E2E harness placeholder",
    localRepositoryPath: "/tmp/e2e-harness-placeholder-unused",
    defaultBranch: "main",
    workManagement: { provider: "linear", containerId: "unused", projectId: "unused" },
    sourceControl: { provider: "github", repository },
  });
}
