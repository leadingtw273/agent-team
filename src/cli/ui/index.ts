import { createUiApplication } from "../../ui/registry/index.js";
import {
  localhostUiHost,
  startLocalUiServer,
  type LocalUiServerHandle,
  type StartLocalUiServerOptions,
} from "../../ui/server/index.js";
import type {
  UiOverviewSummary,
  UiProjectSummary,
  UiShellReadModel,
} from "../../ui/shell/index.js";
import type { CliCommandOutcome, CliHandlers } from "../program.js";
import { createProjectReadModel, type CreateProjectCliHandlersOptions } from "../project/index.js";
import { projectListPayloadSchema, type ProjectListPayload } from "../project/schema.js";
import type { ProjectReadModel } from "../project/read-model.js";

const startupFailureMessage = "無法啟動 Agent Team UI。";
const outputFailureMessage = "無法輸出 Agent Team UI 位址。";
const interruptedMessage = "Agent Team UI 已中斷。";

type ProjectReadPort = Pick<ProjectReadModel, "read">;
type UiServerStarter = (options: StartLocalUiServerOptions) => Promise<LocalUiServerHandle>;

interface UiSnapshot {
  readonly overview: UiOverviewSummary;
  readonly projects: readonly UiProjectSummary[];
}

export interface UiSignalSource {
  once(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

export interface CreateUiCliHandlerOptions {
  readonly agentTeamHome: string;
  readonly createProjectModel?: (options: CreateProjectCliHandlersOptions) => ProjectReadPort;
  readonly startServer?: UiServerStarter;
  readonly writeOut?: (message: string) => void;
  readonly signals?: UiSignalSource;
}

function unavailableSnapshot(): UiSnapshot {
  return Object.freeze({
    overview: Object.freeze({
      source: "runtime",
      teamState: "attention",
      activeJobCount: null,
      registeredProjectCount: null,
      recentEventCount: null,
      runtimeState: "unavailable",
      projectCount: null,
      nonTerminalWorkCount: null,
    }),
    projects: Object.freeze([]),
  });
}

function nullableSum(values: readonly (number | null)[]): number | null {
  if (values.some((value) => value === null)) return null;
  return values.reduce<number>((total, value) => total + (value ?? 0), 0);
}

function snapshotFromPayload(payload: ProjectListPayload): UiSnapshot {
  const inventoryAvailable = payload.inventory.state === "available";
  const projects = Object.freeze(
    payload.projects.map((project) =>
      Object.freeze({
        id: project.id,
        name: project.displayName,
        status: project.registration.state === "registered" ? "ready" : "attention",
        activeJobCount: project.nonTerminalProgressCount,
        registrationState: project.registration.state,
        registrationReason: project.registration.reason,
        nonTerminalCount: project.nonTerminalProgressCount,
        activeLeaseCount: project.activeLeaseCount,
      }),
    ),
  );
  const projectCount = inventoryAvailable ? projects.length : null;
  const registeredProjectCount = inventoryAvailable
    ? projects.filter((project) => project.registrationState === "registered").length
    : null;
  const nonTerminalWorkCount = inventoryAvailable
    ? nullableSum(projects.map((project) => project.nonTerminalCount ?? null))
    : null;

  return Object.freeze({
    overview: Object.freeze({
      source: "runtime",
      teamState: payload.state === "completed" ? "idle" : "attention",
      activeJobCount: nonTerminalWorkCount,
      registeredProjectCount,
      recentEventCount: null,
      runtimeState: payload.state,
      projectCount,
      nonTerminalWorkCount,
    }),
    projects,
  });
}

/**
 * Adapts only the existing T05 list schema to the production shell's tiny server-owned DTOs.
 * The raw payload is parsed, projected, and discarded; it is never attached to a response.
 */
export function createProjectUiShellReadModel(model: ProjectReadPort): UiShellReadModel {
  let snapshot = unavailableSnapshot();

  return Object.freeze({
    refresh: async (): Promise<void> => {
      try {
        const result = await model.read({});
        const parsed = projectListPayloadSchema.safeParse(result.payload);
        snapshot =
          result.state === "success" && parsed.success
            ? snapshotFromPayload(parsed.data)
            : unavailableSnapshot();
      } catch {
        snapshot = unavailableSnapshot();
      }
    },
    readOverview: () => snapshot.overview,
    listProjects: () => snapshot.projects,
    listEvents: () => Object.freeze([]),
  });
}

async function closeSafely(server: LocalUiServerHandle): Promise<void> {
  try {
    await server.close();
  } catch {
    // Lifecycle errors are intentionally collapsed to the fixed CLI outcomes below.
  }
}

async function waitForSigint(server: LocalUiServerHandle, signals: UiSignalSource): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onInterrupt = (): void => {
      if (settled) return;
      settled = true;
      signals.off("SIGINT", onInterrupt);
      void closeSafely(server).then(resolve, resolve);
    };
    try {
      signals.once("SIGINT", onInterrupt);
    } catch {
      reject(new Error("Unable to listen for SIGINT."));
    }
  });
}

/** Production lifecycle for `agent-team ui`: one loopback session, then foreground SIGINT wait. */
export function createUiCliHandler(options: CreateUiCliHandlerOptions): CliHandlers["ui"] {
  const createProjectModel = options.createProjectModel ?? createProjectReadModel;
  const startServer = options.startServer ?? startLocalUiServer;
  const writeOut =
    options.writeOut ??
    ((message: string): void => {
      process.stdout.write(message);
    });
  const signals = options.signals ?? process;

  return async (): Promise<CliCommandOutcome> => {
    let server: LocalUiServerHandle;
    try {
      const readModel = createProjectUiShellReadModel(
        createProjectModel({ agentTeamHome: options.agentTeamHome }),
      );
      const application = createUiApplication({ readModel });
      server = await startServer({
        host: localhostUiHost,
        port: 0,
        handler: application.handler,
        securityPolicy: application.securityPolicy,
      });
    } catch {
      return Object.freeze({ state: "failed", message: startupFailureMessage });
    }

    try {
      writeOut(`Agent Team UI：${server.baseUrl}/#${server.sessionToken}\n`);
    } catch {
      await closeSafely(server);
      return Object.freeze({ state: "failed", message: outputFailureMessage });
    }

    try {
      await waitForSigint(server, signals);
    } catch {
      await closeSafely(server);
      return Object.freeze({ state: "failed", message: startupFailureMessage });
    }
    return Object.freeze({ state: "interrupted", message: interruptedMessage });
  };
}
