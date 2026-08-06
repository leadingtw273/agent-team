/**
 * E008: the closed, fixed set of Live E2E Case ids this aggregate report must always account for --
 * one row per case, taken from docs/plan.md:331-348 (section 15.2 "Live E2E Case" table, E101-E118).
 * This list is a locked decision for this task: it is defined here, not derived from whatever
 * `ValidationReport`s (E007) happen to be handed to `buildAggregateReport` (aggregate.ts) at
 * runtime -- a case that never produced any report still shows up as `missing_report` rather than
 * silently disappearing from the aggregate, and a report for a case id outside this list is treated
 * as an unexpected/impersonating report rather than silently accepted.
 */
export const e101ToE118CaseIds = [
  "E101",
  "E102",
  "E103",
  "E104",
  "E105",
  "E106",
  "E107",
  "E108",
  "E109",
  "E110",
  "E111",
  "E112",
  "E113",
  "E114",
  "E115",
  "E116",
  "E117",
  "E118",
] as const;

export type E101ToE118CaseId = (typeof e101ToE118CaseIds)[number];
