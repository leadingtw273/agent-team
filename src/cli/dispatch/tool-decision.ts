/**
 * C015b item 4: `ProviderToolDecisionPort` (src/application/pipelines/implementer-model.ts)
 * adapter. Decision-layer instruction, verbatim: "危險操作核可需 UI，本票遇到需要核可的操作
 * 一律 fail-closed checkpoint，不得自動核可" -- there is no UI in this ticket's scope, so this
 * adapter never returns `"approve"`. Every `tool_request` event is declined and paused,
 * unconditionally.
 *
 * This still genuinely "接" (wires up) R008's existing classifier
 * (`classifyProcessOperation`, src/application/safety/classifier.ts) -- but only to build a more
 * useful `summary` string for whoever reviews the resulting checkpoint, never to influence the
 * decision itself. This split is deliberate, not a shortcut: a `tool_request.payload` is an
 * untyped `Record<string, unknown>` shaped by whatever the provider CLI's tool-call JSON happens
 * to contain, and there is no reliable, provider-agnostic way to reconstruct a real
 * `ProcessSpawnRequest` (executable + argument array) from it -- see this ticket's completion
 * report for the confirmed, disclosed limitation this implies specifically for the real
 * `ClaudeRunner` (its `respondToToolRequest` always fails regardless of what this adapter
 * returns, because Claude's own CLI already denied the operation before the pipeline ever sees
 * the event -- this adapter's `decline` is honest, not the actual enforcement point). When the
 * payload happens to carry a recognizable `command` string, this adapter makes a best-effort
 * attempt to classify it for the summary text; when it does not, the summary simply says so.
 */
import {
  classifyProcessOperation,
  type ProjectSafetyPolicy,
} from "../../application/safety/index.js";
import type { ProviderToolDecisionPort } from "../../application/pipelines/index.js";
import { ok, parseInstant } from "../../domain/foundation/index.js";
import type { ProviderEvent } from "../../application/ports/index.js";

const fixedFailClosedNotice = "本票無 UI 核可流程，一律 fail-closed checkpoint，不自動核可。";

/** `classifyProcessOperation` never actually reads `deadlineAt`/`maxOutputBytes` (confirmed by
 * reading src/application/safety/classifier.ts -- only `executable`/`arguments`/
 * `workingDirectory` feed the classification) -- this is purely to satisfy `ProcessSpawnRequest`'s
 * type, a fixed, validly-parsed `Instant` rather than an unsafe cast. */
const parsedPlaceholderDeadline = parseInstant(new Date(0).toISOString());
if (!parsedPlaceholderDeadline.ok) throw new Error(parsedPlaceholderDeadline.error.code);
const placeholderDeadline = parsedPlaceholderDeadline.value;

/** Best-effort extraction of a shell-command-like string out of an untyped tool payload -- covers
 * the shape the existing pipeline unit test fixture uses (`payload.command` as a string or a
 * pre-split string array); anything else is left unclassified rather than guessed at. */
function extractCommandGuess(payload: Readonly<Record<string, unknown>>): string | undefined {
  const command = payload["command"];
  if (typeof command === "string" && command.trim().length > 0) return command;
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) {
    const joined = command.join(" ").trim();
    return joined.length > 0 ? joined : undefined;
  }
  return undefined;
}

function summarize(
  event: Extract<ProviderEvent, { kind: "tool_request" }>,
  policy: ProjectSafetyPolicy,
): string {
  const commandGuess = extractCommandGuess(event.payload);
  if (commandGuess === undefined) {
    return `偵測到工具請求（${event.tool}），內容無法辨識為可分類的指令。${fixedFailClosedNotice}`;
  }
  const [executable, ...rest] = commandGuess.split(/\s+/u);
  if (executable === undefined) {
    return `偵測到工具請求（${event.tool}：${commandGuess}）。${fixedFailClosedNotice}`;
  }
  const classification = classifyProcessOperation(
    {
      executable,
      arguments: rest,
      workingDirectory: policy.projectRoot,
      deadlineAt: placeholderDeadline,
      maxOutputBytes: 0,
    },
    policy,
  );
  return `偵測到工具請求（${event.tool}：${commandGuess}），R008 分類為 ${classification.state}${
    classification.state === "dangerous" ? `／${classification.category}` : ""
  }。${fixedFailClosedNotice}`;
}

export class FailClosedToolDecisionAdapter implements ProviderToolDecisionPort {
  constructor(private readonly policyForProject: (projectId: string) => ProjectSafetyPolicy) {}

  decide(
    event: Extract<ProviderEvent, { kind: "tool_request" }>,
    context: Parameters<ProviderToolDecisionPort["decide"]>[1],
  ) {
    const policy = this.policyForProject(context.project.id);
    return Promise.resolve(
      ok(
        Object.freeze({
          response: "decline" as const,
          pause: true,
          summary: summarize(event, policy),
        }),
      ),
    );
  }
}
