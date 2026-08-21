import { randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";

import { z } from "zod";

import {
  createClock,
  domainError,
  err,
  ok,
  parseIdentifier,
  canonicalInstantPattern,
  parseInstant,
  type Clock,
  type DomainError,
  type Instant,
  type Result,
} from "../../domain/foundation/index.js";
import { canonicalChangeRegions, changeRegionsOverlap } from "../../domain/ownership/index.js";
import {
  changeRegionSchema,
  projectIdSchema,
  type ChangeRegion,
} from "../../domain/project/index.js";
import {
  AtomicFileStore,
  acquireRecoverableFileLock,
  readJsonWithSchema,
  writeJsonWithSchema,
} from "../../infrastructure/files/index.js";

const instantSchema = z
  .string()
  .regex(canonicalInstantPattern)
  .refine((value) => parseInstant(value).ok) as unknown as z.ZodType<Instant>;
const revisionSchema = z.number().int().nonnegative();
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/u);
const commitSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u);
const repositoryIdSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[a-z][a-z0-9_-]{0,63}:[^/\s]+(?:\/[^/\s]+)+$/u);

export const humanOwnedRegionReleaseReasonSchema = z.enum(["received", "abandoned"]);
export type HumanOwnedRegionReleaseReason = z.infer<typeof humanOwnedRegionReleaseReasonSchema>;

export const humanOwnedRegionReservationSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: revisionSchema,
    reservationId: z.uuid(),
    projectId: projectIdSchema,
    owner: z.string().trim().min(1).max(255),
    repositoryId: repositoryIdSchema,
    regions: z.array(changeRegionSchema).min(1).max(100),
    baselineRevision: commitSchema,
    baselineWorkingTreeDigest: digestSchema,
    state: z.enum(["active", "released"]),
    releaseReason: humanOwnedRegionReleaseReasonSchema.optional(),
    createdAt: instantSchema,
    updatedAt: instantSchema,
  })
  .strict()
  .superRefine((record, context) => {
    const canonical = canonicalChangeRegions(record.regions);
    if (canonical === undefined || JSON.stringify(canonical) !== JSON.stringify(record.regions)) {
      context.addIssue({
        code: "custom",
        message: "regions must be canonical, unique, and non-overlapping",
        path: ["regions"],
      });
    }
    if ((record.state === "released") !== (record.releaseReason !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "release reason is required exactly for released reservations",
        path: ["releaseReason"],
      });
    }
    if (record.updatedAt < record.createdAt) {
      context.addIssue({
        code: "custom",
        message: "reservation timestamps must be monotonic",
        path: ["updatedAt"],
      });
    }
  });

export type HumanOwnedRegionReservation = z.infer<typeof humanOwnedRegionReservationSchema>;

const ledgerSchema = z
  .object({
    schemaVersion: z.literal(1),
    revision: revisionSchema,
    projectId: projectIdSchema,
    reservations: z.array(humanOwnedRegionReservationSchema).max(1_000),
  })
  .strict()
  .superRefine((ledger, context) => {
    const ids = ledger.reservations.map((reservation) => reservation.reservationId);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "reservation id must be unique",
        path: ["reservations"],
      });
    }
  });

type Ledger = z.infer<typeof ledgerSchema>;

export interface HumanOwnedRegionReservationPort {
  listActive(
    projectId: string,
  ): Promise<Result<readonly HumanOwnedRegionReservation[], DomainError>>;
  reserve(
    input: Readonly<{
      reservationId: string;
      projectId: string;
      owner: string;
      repositoryId: string;
      regions: readonly ChangeRegion[];
      baselineRevision: string;
      baselineWorkingTreeDigest: string;
    }>,
  ): Promise<Result<HumanOwnedRegionReservation, DomainError>>;
  release(
    projectId: string,
    reservationId: string,
    expectedRevision: number,
    reason: HumanOwnedRegionReleaseReason,
  ): Promise<Result<HumanOwnedRegionReservation, DomainError>>;
  checkAdmission(
    input: Readonly<{
      projectId: string;
      repositoryId: string;
      currentRevision: string;
      regions: readonly ChangeRegion[];
    }>,
  ): Promise<Result<HumanOwnedRegionAdmissionDecision, DomainError>>;
}

export type HumanOwnedRegionAdmissionDecision =
  | Readonly<{ state: "allowed" }>
  | Readonly<{
      state: "blocked";
      reason: "invalid_regions" | "reservation_identity_drift" | "human_owned_region_overlap";
      reservationId?: string;
    }>;

function notFound(error: DomainError): boolean {
  return error.code === "not_found";
}

function sameReservationInput(
  record: HumanOwnedRegionReservation,
  input: Parameters<HumanOwnedRegionReservationPort["reserve"]>[0],
  regions: readonly ChangeRegion[],
): boolean {
  return (
    record.projectId === input.projectId &&
    record.owner === input.owner &&
    record.repositoryId === input.repositoryId &&
    record.baselineRevision === input.baselineRevision &&
    record.baselineWorkingTreeDigest === input.baselineWorkingTreeDigest &&
    JSON.stringify(record.regions) === JSON.stringify(regions)
  );
}

export class FileHumanOwnedRegionReservationStore implements HumanOwnedRegionReservationPort {
  readonly #directory: string;
  readonly #files: AtomicFileStore;
  readonly #clock: Clock;

  constructor(
    directory: string,
    files: AtomicFileStore = new AtomicFileStore(),
    clock: Clock = createClock(),
  ) {
    if (!isAbsolute(directory)) throw new Error("human_owned_region_root_must_be_absolute");
    this.#directory = directory;
    this.#files = files;
    this.#clock = clock;
  }

  #path(projectId: string): string {
    return join(this.#directory, `${projectId}.json`);
  }

  #lockPath(projectId: string): string {
    return `${this.#path(projectId)}.lock`;
  }

  async #read(projectId: string): Promise<Result<Ledger | undefined, DomainError>> {
    if (!parseIdentifier("project", projectId).ok) {
      return err(domainError("invariant_violation"));
    }
    const loaded = await readJsonWithSchema(this.#path(projectId), ledgerSchema);
    return !loaded.ok && notFound(loaded.error) ? ok(undefined) : loaded;
  }

  async listActive(
    projectId: string,
  ): Promise<Result<readonly HumanOwnedRegionReservation[], DomainError>> {
    const ledger = await this.#read(projectId);
    if (!ledger.ok) return ledger;
    return ok(
      Object.freeze(
        (ledger.value?.reservations ?? []).filter((reservation) => reservation.state === "active"),
      ),
    );
  }

  async reserve(
    input: Parameters<HumanOwnedRegionReservationPort["reserve"]>[0],
  ): Promise<Result<HumanOwnedRegionReservation, DomainError>> {
    const project = parseIdentifier("project", input.projectId);
    const regions = canonicalChangeRegions(input.regions);
    if (!project.ok || regions === undefined) return err(domainError("invariant_violation"));
    return this.#mutate(input.projectId, (ledger) => {
      const sameId = ledger.reservations.find(
        (reservation) => reservation.reservationId === input.reservationId,
      );
      if (sameId !== undefined) {
        return sameReservationInput(sameId, input, regions)
          ? ok({ ledger, reservation: sameId })
          : err(domainError("conflict"));
      }
      const overlap = ledger.reservations.find(
        (reservation) =>
          reservation.state === "active" &&
          reservation.repositoryId === input.repositoryId &&
          reservation.regions.some((reserved) =>
            regions.some((candidate) => changeRegionsOverlap(reserved, candidate)),
          ),
      );
      if (overlap !== undefined || ledger.reservations.length >= 1_000) {
        return err(domainError("conflict"));
      }
      const now = this.#clock.now();
      const candidate = humanOwnedRegionReservationSchema.safeParse({
        schemaVersion: 1,
        revision: 0,
        reservationId: input.reservationId,
        projectId: project.value,
        owner: input.owner,
        repositoryId: input.repositoryId,
        regions,
        baselineRevision: input.baselineRevision,
        baselineWorkingTreeDigest: input.baselineWorkingTreeDigest,
        state: "active",
        createdAt: now,
        updatedAt: now,
      });
      if (!candidate.success) return err(domainError("invariant_violation"));
      return ok({
        ledger: { ...ledger, reservations: [...ledger.reservations, candidate.data] },
        reservation: candidate.data,
      });
    });
  }

  async release(
    projectId: string,
    reservationId: string,
    expectedRevision: number,
    reason: HumanOwnedRegionReleaseReason,
  ): Promise<Result<HumanOwnedRegionReservation, DomainError>> {
    return this.#mutate(projectId, (ledger) => {
      const current = ledger.reservations.find(
        (reservation) => reservation.reservationId === reservationId,
      );
      if (current === undefined) return err(domainError("not_found"));
      if (current.state === "released") {
        return current.releaseReason === reason
          ? ok({ ledger, reservation: current })
          : err(domainError("conflict"));
      }
      if (current.revision !== expectedRevision) return err(domainError("conflict"));
      const candidate = humanOwnedRegionReservationSchema.safeParse({
        ...current,
        revision: current.revision + 1,
        state: "released",
        releaseReason: reason,
        updatedAt: this.#clock.now(),
      });
      if (!candidate.success) return err(domainError("invariant_violation"));
      return ok({
        ledger: {
          ...ledger,
          reservations: ledger.reservations.map((reservation) =>
            reservation.reservationId === reservationId ? candidate.data : reservation,
          ),
        },
        reservation: candidate.data,
      });
    });
  }

  async checkAdmission(
    input: Parameters<HumanOwnedRegionReservationPort["checkAdmission"]>[0],
  ): Promise<Result<HumanOwnedRegionAdmissionDecision, DomainError>> {
    const regions = canonicalChangeRegions(input.regions);
    if (regions === undefined || !repositoryIdSchema.safeParse(input.repositoryId).success) {
      return ok(Object.freeze({ state: "blocked", reason: "invalid_regions" }));
    }
    const active = await this.listActive(input.projectId);
    if (!active.ok) return active;
    for (const reservation of active.value) {
      if (reservation.repositoryId !== input.repositoryId) continue;
      if (reservation.baselineRevision !== input.currentRevision) {
        return ok(
          Object.freeze({
            state: "blocked",
            reason: "reservation_identity_drift",
            reservationId: reservation.reservationId,
          }),
        );
      }
      if (
        reservation.regions.some((reserved) =>
          regions.some((candidate) => changeRegionsOverlap(reserved, candidate)),
        )
      ) {
        return ok(
          Object.freeze({
            state: "blocked",
            reason: "human_owned_region_overlap",
            reservationId: reservation.reservationId,
          }),
        );
      }
    }
    return ok(Object.freeze({ state: "allowed" }));
  }

  async #mutate(
    projectId: string,
    mutate: (
      ledger: Ledger,
    ) => Result<
      Readonly<{ ledger: Ledger; reservation: HumanOwnedRegionReservation }>,
      DomainError
    >,
  ): Promise<Result<HumanOwnedRegionReservation, DomainError>> {
    const project = parseIdentifier("project", projectId);
    if (!project.ok) return err(domainError("invariant_violation"));
    const lock = await acquireRecoverableFileLock(
      this.#lockPath(projectId),
      `human-owned-region:${String(process.pid)}:${randomUUID()}`,
    );
    if (!lock.ok) return lock;
    const current = await this.#read(projectId);
    let result: Result<HumanOwnedRegionReservation, DomainError>;
    if (!current.ok) {
      result = current;
    } else {
      const ledger: Ledger = current.value ?? {
        schemaVersion: 1,
        revision: 0,
        projectId: project.value,
        reservations: [],
      };
      const mutated = mutate(ledger);
      if (!mutated.ok) {
        result = mutated;
      } else if (mutated.value.ledger === ledger) {
        result = ok(mutated.value.reservation);
      } else {
        const next = ledgerSchema.safeParse({
          ...mutated.value.ledger,
          revision: ledger.revision + 1,
        });
        if (!next.success) {
          result = err(domainError("invariant_violation"));
        } else {
          const written = await writeJsonWithSchema(
            this.#files,
            this.#path(projectId),
            ledgerSchema,
            next.data,
            { visibility: "private" },
          );
          result =
            written.ok && written.value.durability === "confirmed" && written.value.readBack.ok
              ? ok(mutated.value.reservation)
              : err(domainError("external_failure"));
        }
      }
    }
    const released = await lock.value.release();
    return !released.ok && result.ok ? released : result;
  }
}
