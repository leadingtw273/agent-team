import { z } from "zod";

import type {
  ReadOptions,
  RegistrationProbeLinearCapability,
  RegistrationProbeLinearCreateCommand,
  RegistrationProbeLinearIssueSnapshot,
  RegistrationProbeLinearPort,
  RegistrationProbeLinearTarget,
} from "../../application/ports/index.js";
import {
  domainError,
  err,
  ok,
  type DomainError,
  type Result,
} from "../../domain/foundation/index.js";
import type { LinearProjectContext } from "../linear/model.js";
import type { LinearGraphqlTransport } from "../linear/transport.js";
import type { LinearMutationClient } from "../linear/write.js";
import type { LinearReadModel } from "../linear/read.js";

const findByMarkerQuery = `
  query AgentTeamFindProbeIssueByMarker($teamId: ID!, $projectId: ID!, $marker: String!) {
    issues(
      filter: {
        team: { id: { eq: $teamId } }
        project: { id: { eq: $projectId } }
        description: { eq: $marker }
      }
      first: 2
    ) {
      nodes { id state { type } }
    }
  }
`;

const findByMarkerSchema = z
  .object({
    issues: z
      .object({
        nodes: z.array(
          z
            .object({
              id: z.string().min(1),
              state: z.object({ type: z.string().min(1) }).strict(),
            })
            .strict(),
        ),
      })
      .strict(),
  })
  .strict();

function failure<Value>(
  code: DomainError["code"] = "external_failure",
): Result<Value, DomainError> {
  return err(domainError(code));
}

/**
 * Delegates every Linear mutation to the existing `LinearMutationClient` and every read to
 * `LinearReadModel`, exactly as A003's O003 Linear provisioning already does. The catalog it
 * reads is the same fixed-name catalog (`待辦`/`已取消`/...) O003 provisions for every managed
 * project, so this adapter never invents its own state IDs: it verifies the caller-supplied
 * `workflowStateId` against the catalog's real `backlog` state before ever creating an issue.
 */
export class RegistrationProbeLinearAdapter implements RegistrationProbeLinearPort {
  readonly #readModel: Pick<LinearReadModel, "readContext" | "readIssue">;
  readonly #mutationClient: Pick<LinearMutationClient, "createIssue" | "cancelIssueByUser">;
  readonly #transport: Pick<LinearGraphqlTransport, "request">;
  #lastTarget: RegistrationProbeLinearTarget | undefined;

  constructor(
    readModel: Pick<LinearReadModel, "readContext" | "readIssue">,
    mutationClient: Pick<LinearMutationClient, "createIssue" | "cancelIssueByUser">,
    transport: Pick<LinearGraphqlTransport, "request">,
  ) {
    this.#readModel = readModel;
    this.#mutationClient = mutationClient;
    this.#transport = transport;
  }

  async #context(
    target: RegistrationProbeLinearTarget,
    options: ReadOptions,
  ): Promise<Result<LinearProjectContext, DomainError>> {
    const context = await this.#readModel.readContext(target.teamId, target.projectId, options);
    if (!context.ok) return context;
    if (context.value.catalog.stateIdByWorkStatus.backlog !== target.workflowStateId) {
      return failure();
    }
    return context;
  }

  async readCapability(
    target: RegistrationProbeLinearTarget,
    options: ReadOptions = {},
  ): Promise<Result<RegistrationProbeLinearCapability, DomainError>> {
    this.#lastTarget = target;
    const context = await this.#context(target, options);
    if (!context.ok) return context;
    // The full catalog read succeeding, with the caller-supplied ID matching the real `backlog`
    // state, is the only capability signal available without performing a live mutation; both
    // read/write and cancel share it because the same catalog read guarantees a distinct
    // `canceled`-type state also resolved.
    return ok(Object.freeze({ readWrite: true, cancelable: true }));
  }

  async findByMarker(
    target: RegistrationProbeLinearTarget,
    marker: string,
    options: ReadOptions = {},
  ): Promise<Result<RegistrationProbeLinearIssueSnapshot | undefined, DomainError>> {
    this.#lastTarget = target;
    if (marker.length === 0 || marker.length > 512) return failure("invariant_violation");
    const result = await this.#transport.request<
      unknown,
      { teamId: string; projectId: string; marker: string }
    >(
      {
        operationName: "AgentTeamFindProbeIssueByMarker",
        query: findByMarkerQuery,
        variables: { teamId: target.teamId, projectId: target.projectId, marker },
      },
      options,
    );
    if (!result.ok) return result;
    const parsed = findByMarkerSchema.safeParse(result.value);
    if (!parsed.success || parsed.data.issues.nodes.length > 1) return failure();
    const node = parsed.data.issues.nodes[0];
    if (node === undefined) return ok(undefined);
    return ok(
      Object.freeze({
        issueId: node.id,
        state: node.state.type === "canceled" ? ("cancelled" as const) : ("open" as const),
      }),
    );
  }

  async create(
    command: RegistrationProbeLinearCreateCommand,
    options: Parameters<RegistrationProbeLinearPort["create"]>[1],
  ): Promise<Result<Readonly<{ issueId: string }>, DomainError>> {
    this.#lastTarget = command.target;
    const context = await this.#context(command.target, options);
    if (!context.ok) return context;
    const created = await this.#mutationClient.createIssue(context.value, {
      title: command.title,
      description: command.body,
      priority: "low",
      workStatus: "backlog",
    });
    if (!created.ok) return created;
    if (created.value.description !== command.body || created.value.workStatus !== "backlog") {
      return failure();
    }
    return ok(Object.freeze({ issueId: created.value.id }));
  }

  async read(
    issueId: string,
    options: ReadOptions = {},
  ): Promise<Result<RegistrationProbeLinearIssueSnapshot, DomainError>> {
    const target = this.#lastTarget;
    if (target === undefined) return failure("invariant_violation");
    const context = await this.#context(target, options);
    if (!context.ok) return context;
    const snapshot = await this.#readModel.readIssue(context.value, issueId);
    if (!snapshot.ok) return snapshot;
    return ok(
      Object.freeze({
        issueId: snapshot.value.id,
        state:
          snapshot.value.workStatus === "canceled" ? ("cancelled" as const) : ("open" as const),
      }),
    );
  }

  async cancel(
    issueId: string,
    options: Parameters<RegistrationProbeLinearPort["cancel"]>[1],
  ): Promise<Result<RegistrationProbeLinearIssueSnapshot, DomainError>> {
    const target = this.#lastTarget;
    if (target === undefined) return failure("invariant_violation");
    const context = await this.#context(target, options);
    if (!context.ok) return context;
    const cancelled = await this.#mutationClient.cancelIssueByUser(context.value, issueId);
    if (!cancelled.ok) return cancelled;
    if (cancelled.value.workStatus !== "canceled") return failure();
    return ok(Object.freeze({ issueId: cancelled.value.id, state: "cancelled" as const }));
  }
}
