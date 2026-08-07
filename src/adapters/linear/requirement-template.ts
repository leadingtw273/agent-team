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
 * - `estimatedMinutes` accepts **only** text that, once trimmed, is composed entirely of ASCII
 *   digits (`/^\d+$/u`) -- no unit words ("分鐘"/"小時"/"hour"/"h"), no sign, no decimal point, no
 *   scientific notation, no surrounding annotation. This was tightened after an acceptance review
 *   found the original "first integer found anywhere in the text" rule silently misparsed
 *   completely ordinary input in the *unsafe* direction: "2小時" (2 hours) parsed as `2` (minutes),
 *   letting a genuinely 2-hour task slip past `evaluateEligibility`'s `task_too_large` gate
 *   (>45 minutes); "-5" parsed as `5` (the sign silently dropped); "1e9" parsed as `1` (scientific
 *   notation silently truncated). Every one of those must now be `undefined` (-> the ordinary
 *   `missing_estimate` blocker), matching this file's own rule for every other field: uncertain
 *   input is never silently coerced into a small, harmless-looking number -- it is refused and
 *   handed to the existing missing-field path. This is deliberately conservative: a genuinely
 *   well-formed answer like "約 2 小時（120 分鐘）" is *also* rejected (multi-number,
 *   free-text-annotated input is exactly the ambiguous shape this rule refuses to guess at) --
 *   the template's own instruction asks for a bare minutes figure, and only a bare minutes figure
 *   is accepted.
 * - `changeRegions` uses the same bullet-list extraction as acceptance criteria/scope: each
 *   `- <path>` line under "預期變更區域" becomes one `{path, coverage:"exact"}` entry. This was
 *   revised after discovering `ImplementerPipeline.run()` (src/application/pipelines/
 *   implementer.ts) hard-requires a non-empty `changeRegions` on the requirement snapshot's issue
 *   before it will do anything at all (`requestShapeValid`) -- without this, no real candidate
 *   could ever reach the pipeline stage even after clearing eligibility, a second silent
 *   structural block in the same spirit as the one this whole parser exists to close. `"exact"`
 *   (never `"subtree"`) is the deliberately stricter choice: it declares only the literal path
 *   the human wrote as in-scope, so `GitPreflight`'s scope check flags anything else touched as
 *   `outside_declared_region` (triggering the scope-overrun checkpoint) rather than silently
 *   permitting an entire subtree the human never actually named. If a line is not a valid
 *   repository-relative path, the resulting `Issue` fails domain schema validation as a whole
 *   (the existing `issue_invalid` skip path in `discoverReadyDispatchCandidates` already handles
 *   this -- this parser adds no new failure mode for it).
 */
import {
  readyGateTemplateHeadings,
  readyGateTemplatePlaceholder,
} from "../../application/registration/linear-provision-model.js";

export type ReadyGateDependenciesField =
  Readonly<{ kind: "none" }> | Readonly<{ kind: "unparsed" }> | Readonly<{ kind: "absent" }>;

export interface ReadyGateChangeRegion {
  readonly path: string;
  readonly coverage: "exact";
}

export interface ReadyGateTemplateFields {
  readonly goal?: string;
  readonly background?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly inScope?: readonly string[];
  readonly outOfScope?: readonly string[];
  readonly estimatedMinutes?: number;
  readonly constraints?: readonly string[];
  readonly risks?: readonly string[];
  readonly changeRegions?: readonly ReadyGateChangeRegion[];
  readonly dependencies: ReadyGateDependenciesField;
}

const headingLinePattern = /^##\s+(.+?)\s*$/u;
/** Matches either fence marker as its own capture group so the caller can tell which one opened
 * the fence -- see `splitSections`'s own comment on why mixed markers must not close each other. */
const fenceLinePattern = /^\s*(```|~~~)/u;

export interface ParsedSections {
  readonly bodies: ReadonlyMap<string, string>;
  /** Headings that appeared more than once. A repeated heading is never safely resolvable --
   * see `splitSections`'s own header comment (FAIL-B) for why last-wins is the *unsafe*
   * direction here, not merely undefined behavior. */
  readonly duplicated: ReadonlySet<string>;
}

/**
 * Splits a description into a map of heading text -> the raw body text beneath it (up to the
 * next `##` heading or end of text), while tracking two hazards found by acceptance review:
 *
 * - **Repeated headings.** The original implementation kept only the *last* occurrence's body
 *   ("a defensive default, not a feature"). For most fields last-wins is harmless, but for
 *   `dependencies` it is actively unsafe: a real dependency declared first, then silently
 *   overwritten by a later, unrelated "## 依賴關係\n無" section, flips a fail-closed `unparsed`
 *   into a dispatchable `none`. This function now records every heading that occurs more than
 *   once in `duplicated`; callers (`parseDependencies` especially) must treat a duplicated
 *   heading as unsafe to use at all, regardless of which occurrence's text looks fine.
 * - **Fenced code blocks.** A `## 依賴關係`-looking line inside a ``` or `~~~` fence is markdown
 *   sample text, not a real section boundary -- this was letting a code block that merely
 *   *illustrates* the template's own syntax hijack real section parsing (the same underlying
 *   hazard as the duplicate-heading issue: something that looks like the real heading is not the
 *   real answer). Fence state tracks *which marker opened it*: a fence opened with ``` closes
 *   only on a ``` line, one opened with `~~~` closes only on a matching `~~~` line -- a
 *   mismatched marker encountered while already inside a fence is just more fence content, not a
 *   close (this mirrors CommonMark's own fence-pairing rule; an acceptance review found a naive
 *   single-toggle implementation let a `~~~`-fenced fake heading get treated as real once the
 *   toggle had been flipped by an unrelated marker). While inside any open fence, `##`-looking
 *   lines are treated as ordinary body text, never headings.
 */
function splitSections(description: string): ParsedSections {
  const bodies = new Map<string, string>();
  const seenHeadings = new Set<string>();
  const duplicated = new Set<string>();
  let currentHeading: string | undefined;
  let buffer: string[] = [];
  let openFenceMarker: string | undefined;

  function flush(): void {
    if (currentHeading !== undefined) {
      bodies.set(currentHeading, buffer.join("\n"));
    }
  }

  for (const line of description.split(/\r\n|\r|\n/u)) {
    const fenceMatch = fenceLinePattern.exec(line);
    if (fenceMatch?.[1] !== undefined) {
      if (openFenceMarker === undefined) {
        openFenceMarker = fenceMatch[1];
      } else if (openFenceMarker === fenceMatch[1]) {
        openFenceMarker = undefined;
      }
      // A mismatched marker (or any fence line while already inside a fence) is fence content,
      // not a boundary -- it falls through to the ordinary buffer.push below.
      if (currentHeading !== undefined) buffer.push(line);
      continue;
    }
    const match = openFenceMarker === undefined ? headingLinePattern.exec(line) : null;
    if (match?.[1] !== undefined) {
      flush();
      const heading = match[1];
      if (seenHeadings.has(heading)) duplicated.add(heading);
      seenHeadings.add(heading);
      currentHeading = heading;
      buffer = [];
    } else if (currentHeading !== undefined) {
      buffer.push(line);
    }
  }
  flush();
  return Object.freeze({ bodies: Object.freeze(bodies), duplicated: Object.freeze(duplicated) });
}

/** Every field except `dependencies` treats a duplicated heading exactly like a heading that was
 * never found at all -- both end up `undefined`, both fall through to the ordinary `missing_X`
 * blocker. Only `dependencies` needs to distinguish the two (see `parseDependencies`). */
function bodyIfUnique(sections: ParsedSections, heading: string): string | undefined {
  return sections.duplicated.has(heading) ? undefined : sections.bodies.get(heading);
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

const pureDigitsPattern = /^\d+$/u;

function parseEstimatedMinutes(body: string | undefined): number | undefined {
  const text = nonEmptyText(body);
  if (text === undefined) return undefined;
  if (!pureDigitsPattern.test(text)) return undefined;
  const value = Number.parseInt(text, 10);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function parseChangeRegions(
  body: string | undefined,
): readonly ReadyGateChangeRegion[] | undefined {
  const paths = parseBulletList(body);
  if (paths === undefined) return undefined;
  return Object.freeze(paths.map((path) => Object.freeze({ path, coverage: "exact" as const })));
}

/** `duplicated` is checked *before* looking at any body text: a repeated 依賴關係 heading is
 * unsafe to resolve regardless of what the (ambiguous, which-occurrence-even) text says --
 * see `splitSections`'s header comment (FAIL-B). This is deliberately the same `"unparsed"`
 * outcome as "one heading, ambiguous free text" -- both are "the template was followed but this
 * answer cannot be safely trusted," which is exactly the situation `dependencies_unparsed`
 * (src/adapters/dispatch/linear-discovery.ts) exists to make visible rather than silently
 * resolving into a guess. */
function parseDependencies(
  body: string | undefined,
  duplicated: boolean,
): ReadyGateDependenciesField {
  if (duplicated) return Object.freeze({ kind: "unparsed" as const });
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
  const goal = nonEmptyText(bodyIfUnique(sections, readyGateTemplateHeadings.goal));
  const background = nonEmptyText(bodyIfUnique(sections, readyGateTemplateHeadings.background));
  const acceptanceCriteria = parseBulletList(
    bodyIfUnique(sections, readyGateTemplateHeadings.acceptanceCriteria),
  );
  const inScope = parseBulletList(bodyIfUnique(sections, readyGateTemplateHeadings.inScope));
  const outOfScope = parseBulletList(bodyIfUnique(sections, readyGateTemplateHeadings.outOfScope));
  const estimatedMinutes = parseEstimatedMinutes(
    bodyIfUnique(sections, readyGateTemplateHeadings.estimatedMinutes),
  );
  const constraints = parseBulletList(
    bodyIfUnique(sections, readyGateTemplateHeadings.constraints),
  );
  const risks = parseBulletList(bodyIfUnique(sections, readyGateTemplateHeadings.risks));
  const changeRegions = parseChangeRegions(
    bodyIfUnique(sections, readyGateTemplateHeadings.changeRegions),
  );
  const dependencies = parseDependencies(
    sections.bodies.get(readyGateTemplateHeadings.dependencies),
    sections.duplicated.has(readyGateTemplateHeadings.dependencies),
  );

  return Object.freeze({
    ...(goal === undefined ? {} : { goal }),
    ...(background === undefined ? {} : { background }),
    ...(acceptanceCriteria === undefined ? {} : { acceptanceCriteria }),
    ...(inScope === undefined ? {} : { inScope }),
    ...(outOfScope === undefined ? {} : { outOfScope }),
    ...(estimatedMinutes === undefined ? {} : { estimatedMinutes }),
    ...(constraints === undefined ? {} : { constraints }),
    ...(risks === undefined ? {} : { risks }),
    ...(changeRegions === undefined ? {} : { changeRegions }),
    dependencies,
  });
}
