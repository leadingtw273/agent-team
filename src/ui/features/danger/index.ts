import {
  dangerousOperationCategories,
  type DangerousOperationCategory,
} from "../../../application/safety/index.js";
import { Redactor, redactedValue } from "../../../infrastructure/redaction/index.js";

export type DangerApprovalCategory = DangerousOperationCategory | "unknown";
export type DangerApprovalDecision = "approve_once" | "reject" | "allow_project_category";

export interface DangerApprovalRequest {
  readonly requestId: string;
  readonly projectId: string;
  readonly projectName: string;
  readonly category: DangerApprovalCategory;
  readonly purpose: string;
  readonly scope: string;
  readonly revision: string;
}

export interface DangerAuditEvent {
  readonly sequence: number;
  readonly kind: "approved_once" | "rejected" | "project_category_allowed" | "project_category_hit";
  readonly requestId: string;
  readonly projectId: string;
  readonly category: DangerApprovalCategory;
  readonly summary: string;
}

export interface DangerApprovalCommand {
  readonly requestId: string;
  readonly projectId: string;
  readonly category: DangerApprovalCategory;
  readonly expectedRevision: string;
  readonly decision: DangerApprovalDecision;
}

export interface DangerApprovalReadModel {
  readonly waiting: readonly DangerApprovalRequest[];
  readonly longTermAllowed: readonly Readonly<{
    projectId: string;
    category: DangerousOperationCategory;
  }>[];
  readonly audit: readonly DangerAuditEvent[];
}

const categorySet = new Set<string>(dangerousOperationCategories);
const identifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const revisionPattern = /^[a-f0-9]{64}$/u;
const markerScanner = new Redactor();

function validRequest(value: DangerApprovalRequest): boolean {
  return (
    identifierPattern.test(value.requestId) &&
    identifierPattern.test(value.projectId) &&
    value.projectName.trim().length > 0 &&
    value.projectName.length <= 255 &&
    (value.category === "unknown" || categorySet.has(value.category)) &&
    value.purpose.trim().length > 0 &&
    value.purpose.length <= 1_024 &&
    value.scope.trim().length > 0 &&
    value.scope.length <= 2_048 &&
    !`${value.projectName}\n${value.purpose}\n${value.scope}`.includes(redactedValue) &&
    markerScanner.redactText(`${value.projectName}\n${value.purpose}\n${value.scope}`) ===
      `${value.projectName}\n${value.purpose}\n${value.scope}` &&
    revisionPattern.test(value.revision)
  );
}

function frozenRequest(value: DangerApprovalRequest): DangerApprovalRequest {
  if (!validRequest(value)) throw new TypeError("Invalid danger approval request.");
  return Object.freeze({ ...value });
}

export class InMemoryDangerApprovalStore {
  #waiting: DangerApprovalRequest[];
  #longTermAllowed = new Set<string>();
  #audit: DangerAuditEvent[] = [];

  constructor(waiting: readonly DangerApprovalRequest[] = []) {
    this.#waiting = waiting.map(frozenRequest);
    if (new Set(this.#waiting.map((item) => item.requestId)).size !== this.#waiting.length) {
      throw new TypeError("Duplicate danger approval request.");
    }
  }

  read(): DangerApprovalReadModel {
    return Object.freeze({
      waiting: Object.freeze([...this.#waiting]),
      longTermAllowed: Object.freeze(
        [...this.#longTermAllowed].map((key) => {
          const [projectId, category] = key.split("\u0000") as [string, DangerousOperationCategory];
          return Object.freeze({ projectId, category });
        }),
      ),
      audit: Object.freeze([...this.#audit]),
    });
  }

  decide(command: DangerApprovalCommand): Readonly<{ state: "saved" | "conflict" | "rejected" }> {
    const index = this.#waiting.findIndex((item) => item.requestId === command.requestId);
    const request = this.#waiting[index];
    if (request === undefined) return Object.freeze({ state: "conflict" });
    if (
      request.projectId !== command.projectId ||
      request.category !== command.category ||
      request.revision !== command.expectedRevision
    ) {
      return Object.freeze({ state: "conflict" });
    }
    if (
      request.category === "unknown" &&
      (command.decision === "approve_once" || command.decision === "allow_project_category")
    ) {
      return Object.freeze({ state: "rejected" });
    }
    this.#waiting.splice(index, 1);
    const category = request.category === "unknown" ? undefined : request.category;
    if (command.decision === "allow_project_category" && category !== undefined) {
      this.#longTermAllowed.add(`${request.projectId}\u0000${category}`);
    }
    this.#append(
      command.decision === "approve_once"
        ? "approved_once"
        : command.decision === "reject"
          ? "rejected"
          : "project_category_allowed",
      request,
      request.category,
    );
    return Object.freeze({ state: "saved" });
  }

  recordLongTermHit(requestValue: DangerApprovalRequest): Readonly<{
    state: "authorized" | "not_allowed";
  }> {
    const request = frozenRequest(requestValue);
    if (
      request.category === "unknown" ||
      !this.#longTermAllowed.has(`${request.projectId}\u0000${request.category}`)
    ) {
      return Object.freeze({ state: "not_allowed" });
    }
    this.#append("project_category_hit", request, request.category);
    return Object.freeze({ state: "authorized" });
  }

  #append(
    kind: DangerAuditEvent["kind"],
    request: DangerApprovalRequest,
    category: DangerApprovalCategory,
  ): void {
    this.#audit.push(
      Object.freeze({
        sequence: this.#audit.length + 1,
        kind,
        requestId: request.requestId,
        projectId: request.projectId,
        category,
        summary: `${request.projectName} · ${request.purpose}`,
      }),
    );
  }
}

export function createDangerApprovalUseCase(store: InMemoryDangerApprovalStore) {
  return Object.freeze({
    read: (): DangerApprovalReadModel => store.read(),
    decide: (command: DangerApprovalCommand) => store.decide(command),
    recordLongTermHit: (request: DangerApprovalRequest) => store.recordLongTermHit(request),
    applyLinearComment: (comment: string) => {
      void comment;
      return Object.freeze({ state: "ignored" as const });
    },
  });
}

export type DangerApprovalUseCase = ReturnType<typeof createDangerApprovalUseCase>;

export * from "./http.js";
export * from "./registration.js";
export * from "./routes.js";
export * from "./view.js";
