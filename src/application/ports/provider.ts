import type { Checkpoint } from "../../domain/checkpoint/index.js";
import type { DomainError, Instant } from "../../domain/foundation/index.js";
import type { Job } from "../../domain/jobs/index.js";
import type { AgentRole } from "../../domain/project/index.js";
import type { RequirementSnapshot } from "../../domain/review/index.js";
import type { AsyncPortResult, ReadOptions } from "./common.js";

interface ExternalDataBase {
  readonly source: string;
  readonly mediaType: string;
}

export interface ExternalTextDataBlock extends ExternalDataBase {
  readonly kind: "text";
  readonly content: string;
}

export interface ExternalFileDataBlock extends ExternalDataBase {
  readonly kind: "file";
  readonly path: string;
  readonly sha256: string;
}

export type ExternalDataBlock = ExternalTextDataBlock | ExternalFileDataBlock;

export interface ProviderCapabilities {
  readonly provider: string;
  readonly cliVersion: string;
  readonly models: readonly string[];
  readonly supportsResume: boolean;
  readonly supportsStructuredEvents: boolean;
  readonly supportsDynamicApproval: boolean;
  readonly supportsVisualInput: boolean;
}

export interface ProviderRunRequest {
  readonly job: Job;
  readonly role: AgentRole;
  readonly model: string;
  readonly workingDirectory: string;
  readonly requirementSnapshot: RequirementSnapshot;
  readonly controllerDirective: string;
  readonly projectRules: readonly string[];
  readonly externalData: readonly ExternalDataBlock[];
  readonly checkpoint?: Checkpoint;
  readonly deadlineAt: Instant;
}

export type ProviderEvent =
  | Readonly<{ kind: "started"; observedAt: Instant; sessionId?: string }>
  | Readonly<{
      kind: "model_selected";
      observedAt: Instant;
      requestedModel: string;
      actualModels: readonly string[];
    }>
  | Readonly<{ kind: "output"; observedAt: Instant; stream: "stdout" | "stderr"; text: string }>
  | Readonly<{
      kind: "tool_request";
      observedAt: Instant;
      requestId: string;
      tool: string;
      payload: Readonly<Record<string, unknown>>;
    }>
  | Readonly<{ kind: "checkpoint"; observedAt: Instant; checkpoint: Checkpoint }>
  | Readonly<{ kind: "quota_boundary"; observedAt: Instant; bucket: "weekly" | "five_hour" }>
  | Readonly<{ kind: "completed"; observedAt: Instant }>
  | Readonly<{ kind: "failed"; observedAt: Instant; error: DomainError }>;

export type ProviderRunCompletion =
  | Readonly<{ outcome: "completed"; sessionId?: string }>
  | Readonly<{ outcome: "interrupted"; sessionId?: string }>
  | Readonly<{ outcome: "failed"; sessionId?: string; error: DomainError }>;

export interface ProviderRunHandle {
  readonly runId: string;
  readonly events: AsyncIterable<ProviderEvent>;
  completion(options?: ReadOptions): AsyncPortResult<ProviderRunCompletion>;
  respondToToolRequest(
    requestId: string,
    decision: "approve" | "decline",
    options?: ReadOptions,
  ): AsyncPortResult<void>;
  interrupt(options?: ReadOptions): AsyncPortResult<void>;
}

export interface ProviderPort {
  inspectCapabilities(options?: ReadOptions): AsyncPortResult<ProviderCapabilities>;
  start(request: ProviderRunRequest, options?: ReadOptions): AsyncPortResult<ProviderRunHandle>;
}
