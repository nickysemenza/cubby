import { entityRefKey } from "@cubby/schemas/entity";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { describeJobWaitingOn } from "@cubby/schemas/job";
import { type JobFilters } from "@cubby/schemas/job-entity";
import { rawJobOut, type RawJobOut } from "@cubby/schemas/job-raw-read";
import type { PaginationParams, SortParams } from "@cubby/schemas/pagination";
import { inArray } from "drizzle-orm";

import type { Database, DrizzleTransaction } from "~/server/db";
import {
  databaseForTransaction,
  isTransaction,
  unwrapDb,
} from "~/server/db/helpers";
import type { ListReadIntent } from "~/server/db/helpers/query";
import { job } from "~/server/db/retained-tables";
import type { EntityKernelContext } from "~/server/entity-kernel/adapter";
import { resolveEntityDisplayImageLists } from "~/server/entity-kernel/repo/entity-display-image";
import {
  createEntityReader,
  createEntityRowFetcher,
  defineRepository,
} from "~/server/entity-kernel/repo/repository";
import { jobKindPolicy } from "~/server/generic/jobs/kind-policy";
import { jobEntityScaffold } from "~/server/generic/jobs/repo/entity-list";
import { loadJobWaitingOn } from "~/server/generic/jobs/repo/waiting-on";
import type { ListProjection } from "~/server/generic/list/repo/list-contracts";
import {
  listReadPlan,
  type ListReadOptions,
} from "~/server/generic/list/repo/list-projection";
import { completeListReader } from "~/server/generic/list/repo/list-read-adapters";
import { lookupEntityReferences } from "~/server/generic/shortcode/repo/shortcode-resolver";

type JobRow = typeof job.$inferSelect;

const read = {
  media: true,
  displayImages: async (db, ids) => {
    const rows = ids.length
      ? await unwrapDb(db)
          .select({
            id: job.id,
            subjectKind: job.subjectKind,
            subjectId: job.subjectId,
          })
          .from(job)
          .where(
            inArray(
              job.id,
              ids.map((id) => parseEntityId("job", id)),
            ),
          )
      : [];
    const images = await resolveEntityDisplayImageLists(
      db,
      rows.flatMap((row) =>
        row.subjectKind === "image" && row.subjectId
          ? [{ entityKind: "image", entityId: row.subjectId }]
          : [],
      ),
    );
    return new Map(
      rows.map((row) => [
        entityRefKey("job", row.id),
        row.subjectKind === "image" && row.subjectId
          ? (images.get(entityRefKey("image", row.subjectId)) ?? [])
          : [],
      ]),
    );
  },
  references: {
    runId: { kind: "lookup", missing: "null", includeDeleted: true },
  },
  bindings: (bind) => {
    const waiting = bind.batch(({ db, rows }) =>
      loadJobWaitingOn(
        isTransaction(db) ? databaseForTransaction(db) : db,
        rows,
      ),
    );
    const subjects = bind.batch(async ({ db, rows }) => {
      const [images, locations] = await Promise.all([
        lookupEntityReferences(
          db,
          "image",
          rows.flatMap((row) =>
            row.subjectKind === "image" && row.subjectId ? [row.subjectId] : [],
          ),
          { includeDeleted: true },
        ),
        lookupEntityReferences(
          db,
          "location",
          rows.flatMap((row) =>
            row.subjectKind === "location" && row.subjectId
              ? [row.subjectId]
              : [],
          ),
          { includeDeleted: true },
        ),
      ]);
      return { images, locations };
    });
    return [
      bind(rawJobOut.pick({ lane: true }), (row) => ({
        lane: jobKindPolicy(row.kind).lane,
      })),
      waiting.fields(rawJobOut.pick({ waitingOn: true }), (row, loaded) => ({
        waitingOn: describeJobWaitingOn(loaded.get(row.id) ?? null),
      })),
      subjects.fields(
        rawJobOut.pick({ imageId: true, locationId: true }),
        (row, loaded) => ({
          imageId:
            row.subjectKind === "image" && row.subjectId
              ? (loaded.images.get(row.subjectId)?.id ?? null)
              : null,
          locationId:
            row.subjectKind === "location" && row.subjectId
              ? (loaded.locations.get(row.subjectId)?.id ?? null)
              : null,
        }),
      ),
    ];
  },
} satisfies ListReadOptions<JobRow>;

const plan = () => listReadPlan<JobRow>("job", read);
const listRead = (
  db: Database,
  filters: JobFilters,
  sorts: SortParams[],
  pagination: PaginationParams,
  projection: ListProjection = { kind: "full" },
  readIntent: ListReadIntent = "page",
) =>
  jobEntityScaffold().read(
    db,
    {
      filters,
      sorts,
      pagination,
      projection,
      readIntent,
    },
    { read },
  );
const list = completeListReader(rawJobOut, listRead);
const reader = createEntityReader<
  JobRow,
  RawJobOut,
  "job",
  Database | DrizzleTransaction
>({
  entity: "job",
  fetchById: createEntityRowFetcher(job),
  fromDB: async (db, row) =>
    rawJobOut.parse((await plan().read(db, [row], { kind: "full" }))[0]),
});

export const jobRepository = defineRepository("job", {
  get: (ctx: EntityKernelContext, code: string) =>
    reader.getByShortcode(ctx.db, code),
  list: (
    ctx: EntityKernelContext,
    filters: JobFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
  ) => list(ctx.db, filters, sorts, pagination),
  listRead: (
    ctx: EntityKernelContext,
    filters: JobFilters,
    sorts: SortParams[],
    pagination: PaginationParams,
    projection: ListProjection,
    readIntent: ListReadIntent = "page",
  ) => listRead(ctx.db, filters, sorts, pagination, projection, readIntent),
});
