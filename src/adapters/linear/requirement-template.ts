/**
 * C015b: pure parser turning a Linear issue's free-text `description` into the structured
 * `Issue` fields the "Agent Team｜需求受理" Ready Gate template asks a human to fill in when
 * creating a real requirement issue. Single source of truth for the section headings: this
 * module imports `readyGateTemplateHeadings`/`readyGateTemplatePlaceholder`
 * (src/application/registration/linear-provision-model.ts) rather than duplicating the heading
 * strings as literals -- the provisioned Linear template and this parser can never drift apart.
 *
 * Design decisions (escalated to and approved by the decision layer before this file was
 * written -- see the C015b completion report for the full rationale):
 *
 * - Any field whose heading is not found, or whose content under the heading is empty or is
 *   only the template's own placeholder text, is left absent from the returned object (never
 *   assigned an empty string/array). Downstream, `evaluateEligibility`
 *   (src/domain/eligibility/decision.ts) already reports a `missing_X` blocker for every such
 *   absent field -- this parser deliberately does not invent a second way to report "not
 *   filled in."
 * - `dependencies` is the one field with three-way, not two-way, meaning. The template's own
 *   instruction is "必填；沒有請填「無」" (required; write "無" if there is none). A
 *   heading present with empty content, or with `"無"` (any surrounding whitespace trimmed),
 *   maps to `{kind:"none"}`. A heading present with *any other* text maps to `{kind:"unparsed"}`
 *   -- deliberately never converted into a guessed `DependencyDeclaration.issueIds` list, because
 *   this parser (like `toDomainIssue` in src/adapters/dispatch/linear-discovery.ts) has no safe
 *   way to resolve free text into real issue identifiers. Treating "wrote something" the same as
 *   "wrote nothing" here would silently dispatch work the issue author explicitly flagged as
 *   depending on something else -- a mis-dispatch risk the decision layer explicitly rejected.
 *   A heading not found at all maps to `{kind:"absent"}`, which the caller (`toDomainIssue`)
 *   treats identically to any other missing template field (goes through `missing_dependencies`,
 *   not a special path) -- only a *found-but-ambiguous* heading is the caller's cue to skip the
 *   whole candidate up front (see `discoverReadyDispatchCandidates`'s `dependencies_unparsed`
 *   skip reason), because "the template was followed but we can't safely interpret one required
 *   answer" is a materially different situation from "the template was not followed at all."
 * - `estimatedMinutes` takes the first integer found in the section's text. No unit words
 *   ("分鐘"/"小時") are parsed -- the template's own guidance ("目標 15～30 分鐘") only ever
 *   asks for a minutes figure, so the first bare integer is the minutes count. Text with no
 *   integer at all is left absent, letting `evaluateEligibility`'s `missing_estimate` blocker
 *   catch it.
 * - `changeRegions` is intentionally never parsed here: the template's own "預期變更區域" field
 *   has no defined sub-structure (unlike the flat bullet lists for acceptance criteria/scope),
 *   and `Issue.changeRegions` requires `{path, coverage}` pairs this parser has no reliable way
 *   to derive from free text. It is optional and not an eligibility blocker on its own.
 */
import {
  readyGateTemplateHeadings,
  readyGateTemplatePlaceholder,
} from "../../application/registration/linear-provision-model.js";

export type ReadyGateDependenciesField =
  Readonly<{ kind: "none" }> | Readonly<{ kind: "unparsed" }> | Readonly<{ kind: "absent" }>;

export interface ReadyGateTemplateFields {
  readonly goal?: string;
  readonly background?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly inScope?: readonly string[];
  readonly outOfScope?: readonly string[];
  readonly estimatedMinutes?: number;
  readonly constraints?: readonly string[];
  readonly risks?: readonly string[];
  readonly dependencies: ReadyGateDependenciesField;
}

const headingLinePattern = /^##\s+(.+?)\s*$/u;

/** Splits a description into a map of heading text -> the raw body text beneath it (up to the
 * next `##` heading or end of text). A heading that appears more than once keeps only its last
 * occurrence's body -- the template never repeats a heading, so this is a defensive default, not
 * a feature. */
function splitSections(description: string): ReadonlyMap<string, string> {
  const sections = new Map<string, string>();
  let currentHeading: string | undefined;
  let buffer: string[] = [];

  function flush(): void {
    if (currentHeading !== undefined) {
      sections.set(currentHeading, buffer.join("\n"));
    }
  }

  for (const line of description.split(/\r\n|\r|\n/u)) {
    const match = headingLinePattern.exec(line);
    if (match?.[1] !== undefined) {
      flush();
      currentHeading = match[1];
      buffer = [];
    } else if (currentHeading !== undefined) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

function nonEmptyText(body: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  const trimmed = body.trim();
  return trimmed.length === 0 || trimmed === readyGateTemplatePlaceholder ? undefined : trimmed;
}

function parseBulletList(body: string | undefined): readonly string[] | undefined {
  if (body === undefined) return undefined;
  const items = body
    .split(/\r\n|\r|\n/u)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0 && line !== readyGateTemplatePlaceholder);
  return items.length === 0 ? undefined : Object.freeze(items);
}

function parseEstimatedMinutes(body: string | undefined): number | undefined {
  const text = nonEmptyText(body);
  if (text === undefined) return undefined;
  const match = /\d+/u.exec(text);
  if (match === null) return undefined;
  const value = Number.parseInt(match[0], 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseDependencies(body: string | undefined): ReadyGateDependenciesField {
  if (body === undefined) return Object.freeze({ kind: "absent" as const });
  const trimmed = body.trim();
  if (trimmed.length === 0 || trimmed === "無") return Object.freeze({ kind: "none" as const });
  return Object.freeze({ kind: "unparsed" as const });
}

export function parseReadyGateTemplate(description: string | undefined): ReadyGateTemplateFields {
  if (description === undefined) {
    return Object.freeze({ dependencies: Object.freeze({ kind: "absent" as const }) });
  }

  const sections = splitSections(description);
  const goal = nonEmptyText(sections.get(readyGateTemplateHeadings.goal));
  const background = nonEmptyText(sections.get(readyGateTemplateHeadings.background));
  const acceptanceCriteria = parseBulletList(
    sections.get(readyGateTemplateHeadings.acceptanceCriteria),
  );
  const inScope = parseBulletList(sections.get(readyGateTemplateHeadings.inScope));
  const outOfScope = parseBulletList(sections.get(readyGateTemplateHeadings.outOfScope));
  const estimatedMinutes = parseEstimatedMinutes(
    sections.get(readyGateTemplateHeadings.estimatedMinutes),
  );
  const constraints = parseBulletList(sections.get(readyGateTemplateHeadings.constraints));
  const risks = parseBulletList(sections.get(readyGateTemplateHeadings.risks));
  const dependencies = parseDependencies(sections.get(readyGateTemplateHeadings.dependencies));

  return Object.freeze({
    ...(goal === undefined ? {} : { goal }),
    ...(background === undefined ? {} : { background }),
    ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    ...(inScope === undefined ? {} : { inScope }),
    ...(outOfScope === undefined ? {} : { outOfScope }),
    ...(estimatedMinutes === undefined ? {} : { estimatedMinutes }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(risks === undefined ? {} : { risks }),
    dependencies,
  });
}
