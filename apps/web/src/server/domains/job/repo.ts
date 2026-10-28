import { entityRefKey } from "@cubby/schemas/entity";
import { jobRawOut as rawJobOut } from "@cubby/schemas/entity-contracts/job";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { describeJobWaitingOn } from "@cubby/schemas/job";
import { inArray } from "drizzle-orm";

import {
  databaseForTransaction,
  isTransaction,
  unwrapDb,
} from "~/server/db/helpers";
import { job } from "~/server/db/retained-tables";
import { resolveEntityDisplayImageLists } from "~/server/entity-kernel/repo/entity-display-image";
import { defineRepository } from "~/server/entity-kernel/repo/repository";
import { jobKindPolicy } from "~/server/generic/jobs/kind-policy";
import { jobScaffoldOptions } from "~/server/generic/jobs/repo/entity-list";
import { loadJobWaitingOn } from "~/server/generic/jobs/repo/waiting-on";
import { listScaffold } from "~/server/generic/list/repo/list";
import { type ListReadOptions } from "~/server/generic/list/repo/list-projection";
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

export const jobScaffold = listScaffold("job", job, {
  ...jobScaffoldOptions,
  read,
});

export const jobRepository = defineRepository("job", {
  scaffold: jobScaffold,
});
