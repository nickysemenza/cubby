/**
 * PostgreSQL half of CalDAV.  Calendar clients never call this module for a
 * read: the Durable Object serves a published SQLite generation.  It is used
 * only to build that generation and to route an accepted DAV write through the
 * same Meal/Task repositories as every other Cubby mutation.
 */
import {
  mealId,
  mealShortcode,
  parseShortcodeFor,
  taskId,
  taskShortcode,
} from "@cubby/schemas/identifiers";
import { MEAL_TYPE_LABELS } from "@cubby/schemas/meal-classification";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";

import {
  type CalDavWrite,
  type CalDavWriteResult,
  type CalendarIdentity,
  type CalendarProjection,
  CalDavError,
} from "~/server/calendar/caldav-types";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  calendarResourceIdentity,
  calendarWriteReceipt,
  meal,
  task,
} from "~/server/db/schema";
import {
  executeEntity,
  type EntityKernelContext,
} from "~/server/entity-kernel";
import { AppError } from "~/server/errors/app-error";
import { isUniqueViolation } from "~/server/errors/db-errors";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { buildCrudServices } from "~/server/request-context";
import { runMutationSideEffects } from "~/server/services/mutation-side-effects";

const UID_DOMAIN = "cubby.nickysemenza.com";
const PAGE_SIZE = 500;

const shiftDate = (value: string, days: number) => {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) {
    throw new CalDavError(400, "Invalid calendar date");
  }
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
};

const timestamp = (value: Date) => value.toISOString();

const projectionKey = (entity: "meal" | "task", id: string) =>
  `${entity}:${id}`;

/**
 * Full, intentionally unbounded projection for the DO publisher.  The UI
 * calendar has range/rollup behavior unsuitable for CalDAV; this scans only
 * the two canonical entity tables in pages and does no recipe/project work.
 */
export async function loadCalDavProjection(db: Database): Promise<{
  projections: CalendarProjection[];
  identities: CalendarIdentity[];
}> {
  return withTransaction(db, async (tx) => {
    // Pagination must observe one generation even while ordinary Cubby writes
    // continue. This is a read-only publication snapshot, not a coordination
    // lock: writers remain free to commit and trigger the next refresh.
    await tx.execute(
      sql`set transaction isolation level repeatable read read only`,
    );
    const meals: Array<
      Pick<
        typeof meal.$inferSelect,
        "id" | "shortcode" | "name" | "date" | "mealType" | "updatedAt"
      >
    > = [];
    const tasks: Array<
      Pick<
        typeof task.$inferSelect,
        | "id"
        | "shortcode"
        | "name"
        | "dueDate"
        | "dueEndDate"
        | "status"
        | "updatedAt"
      >
    > = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await tx.query.meal.findMany({
        where: notDeleted(meal),
        columns: {
          id: true,
          shortcode: true,
          name: true,
          date: true,
          mealType: true,
          updatedAt: true,
        },
        orderBy: (row, { asc }) => [asc(row.createdAt), asc(row.id)],
        limit: PAGE_SIZE,
        offset,
      });
      meals.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await tx.query.task.findMany({
        where: and(
          notDeleted(task),
          or(isNotNull(task.dueDate), isNotNull(task.dueEndDate)),
        ),
        columns: {
          id: true,
          shortcode: true,
          name: true,
          dueDate: true,
          dueEndDate: true,
          status: true,
          updatedAt: true,
        },
        orderBy: (row, { asc }) => [asc(row.createdAt), asc(row.id)],
        limit: PAGE_SIZE,
        offset,
      });
      tasks.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    const identities: Array<typeof calendarResourceIdentity.$inferSelect> = [];
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const page = await tx
        .select()
        .from(calendarResourceIdentity)
        .orderBy(
          calendarResourceIdentity.entityType,
          calendarResourceIdentity.entityId,
        )
        .limit(PAGE_SIZE)
        .offset(offset);
      identities.push(...page);
      if (page.length < PAGE_SIZE) break;
    }
    const identityByEntity = new Map(
      identities.map((row) => [
        projectionKey(row.entityType, row.entityId),
        row,
      ]),
    );
    const entityIdByShortcode = new Map<string, string>([
      ...meals.map((row): [string, string] => [
        projectionKey("meal", row.shortcode),
        row.id,
      ]),
      ...tasks.map((row): [string, string] => [
        projectionKey("task", row.shortcode),
        row.id,
      ]),
    ]);
    const projections: CalendarProjection[] = [
      ...meals.map((row) => ({
        entity: "meal" as const,
        id: parseShortcodeFor("meal", row.shortcode),
        name: row.name,
        date: row.date,
        mealType: row.mealType,
        updatedAt: timestamp(row.updatedAt),
      })),
      ...tasks.map((row) => ({
        entity: "task" as const,
        id: parseShortcodeFor("task", row.shortcode),
        name: row.name,
        dueDate: row.dueDate,
        dueEndDate: row.dueEndDate,
        status: row.status,
        updatedAt: timestamp(row.updatedAt),
      })),
    ];
    return {
      projections,
      identities: projections.map((projection) => {
        const entityId = entityIdByShortcode.get(
          projectionKey(projection.entity, projection.id),
        );
        const row = entityId
          ? identityByEntity.get(projectionKey(projection.entity, entityId))
          : undefined;
        // Older Cubby rows predate CalDAV. Their shortcode namespace is
        // permanent, so this deterministic fallback is already stable without
        // turning a read-only projection pass into a PostgreSQL write.
        return {
          entity: projection.entity,
          shortcode: projection.id,
          filename: row?.filename ?? `${projection.id}.ics`,
          uid: row?.uid ?? `${projection.id}@${UID_DOMAIN}`,
        };
      }),
    };
  });
}

type StoredReceipt = CalDavWriteResult & {
  operationId: string;
  entityType: "meal" | "task";
  entityId: string;
  action: "created" | "updated" | "deleted";
  sideEffectsCompleted: boolean;
};

async function getStoredCalDavWriteReceipt(
  db: Database,
  operationId: string,
): Promise<StoredReceipt | null> {
  const [receipt] = await getDb(db)
    .select({
      operationId: calendarWriteReceipt.operationId,
      shortcode: calendarWriteReceipt.shortcode,
      deleted: calendarWriteReceipt.deleted,
      entityType: calendarWriteReceipt.entityType,
      entityId: calendarWriteReceipt.entityId,
      action: calendarWriteReceipt.action,
      sideEffectsCompleted: calendarWriteReceipt.sideEffectsCompleted,
    })
    .from(calendarWriteReceipt)
    .where(eq(calendarWriteReceipt.operationId, operationId));
  return receipt ?? null;
}

export async function getCalDavWriteReceipt(
  db: Database,
  operationId: string,
): Promise<CalDavWriteResult | null> {
  const receipt = await getStoredCalDavWriteReceipt(db, operationId);
  return receipt
    ? { shortcode: receipt.shortcode, deleted: receipt.deleted }
    : null;
}

const storeReceipt =
  (
    operationId: string,
    entityType: "meal" | "task",
    entityId: string,
    action: "created" | "updated" | "deleted",
    shortcode: string,
    deleted: boolean,
  ) =>
  async (tx: DrizzleTransaction) => {
    await tx.insert(calendarWriteReceipt).values({
      operationId,
      entityType,
      entityId,
      action,
      shortcode,
      deleted,
    });
  };

const caldavContext = (
  db: Database,
  actorId: CalDavWrite["actorId"],
  hooks: NonNullable<EntityKernelContext["caldavHooks"]>,
) => ({
  ...buildCrudServices(db),
  readDb: db,
  actorContext: { userId: actorId, source: "caldav" as const },
  caldavHooks: hooks,
});

async function completeReceiptSideEffects(
  db: Database,
  receipt: StoredReceipt,
) {
  if (receipt.sideEffectsCompleted) return;
  if (receipt.action === "deleted") {
    await markReceiptSideEffectsCompleted(db, receipt.operationId);
    return;
  }
  const entity =
    receipt.entityType === "meal"
      ? {
          entityType: "meal" as const,
          entityId: mealId.parse(receipt.entityId),
        }
      : {
          entityType: "task" as const,
          entityId: taskId.parse(receipt.entityId),
        };
  await runMutationSideEffects(db, {
    action: receipt.action,
    entity,
    source: `caldav.${receipt.action}`,
  });
  await getDb(db)
    .update(calendarWriteReceipt)
    .set({ sideEffectsCompleted: true })
    .where(eq(calendarWriteReceipt.operationId, receipt.operationId));
}

const markReceiptSideEffectsCompleted = async (
  db: Database,
  operationId: string,
) => {
  await getDb(db)
    .update(calendarWriteReceipt)
    .set({ sideEffectsCompleted: true })
    .where(eq(calendarWriteReceipt.operationId, operationId));
};

const expectedProjection = (write: CalDavWrite) => {
  if (!write.expected)
    throw new CalDavError(
      412,
      "CalDAV resource no longer exists",
      "etag-mismatch",
    );
  return write.expected.projection;
};

/** Lock and compare the actual canonical fields, not merely a stale DO ETag. */
async function assertExpected(
  tx: DrizzleTransaction,
  projection: CalendarProjection,
) {
  if (projection.entity === "meal") {
    const [row] = await tx
      .select()
      .from(meal)
      .where(and(eq(meal.shortcode, projection.id), notDeleted(meal)))
      .for("update");
    if (
      !row ||
      row.name !== projection.name ||
      row.date !== projection.date ||
      row.mealType !== projection.mealType
    ) {
      throw new CalDavError(412, "Meal changed in Cubby", "etag-mismatch");
    }
    return;
  }
  const [row] = await tx
    .select()
    .from(task)
    .where(and(eq(task.shortcode, projection.id), notDeleted(task)))
    .for("update");
  if (
    !row ||
    row.name !== projection.name ||
    row.dueDate !== projection.dueDate ||
    row.dueEndDate !== projection.dueEndDate ||
    row.status !== projection.status
  ) {
    throw new CalDavError(412, "Task changed in Cubby", "etag-mismatch");
  }
}

const eventRequired = (write: CalDavWrite) => {
  if (!write.event) throw new CalDavError(400, "VEVENT is required");
  return write.event;
};

/** Existing Cubby rows own their deterministic shortcode identities even
 * before CalDAV is enabled. A new client resource may not squat on either
 * namespace, otherwise a later full projection could collide with it. */
function rejectReservedIdentity(filename: string, uid: string) {
  const filenameStem = filename.endsWith(".ics")
    ? filename.slice(0, -".ics".length)
    : filename;
  const reservedFilename =
    mealShortcode.safeParse(filenameStem).success ||
    taskShortcode.safeParse(filenameStem).success;
  const suffix = `@${UID_DOMAIN}`;
  const uidStem = uid.endsWith(suffix) ? uid.slice(0, -suffix.length) : null;
  const reservedUid =
    uidStem !== null &&
    (mealShortcode.safeParse(uidStem).success ||
      taskShortcode.safeParse(uidStem).success);
  if (reservedFilename || reservedUid) {
    throw new CalDavError(
      409,
      "Cubby calendar resource identity is reserved",
      "no-uid-conflict",
    );
  }
}

async function executeCalDavWriteUnsafe(
  db: Database,
  write: CalDavWrite,
): Promise<CalDavWriteResult> {
  const prior = await getStoredCalDavWriteReceipt(db, write.operationId);
  if (prior) {
    await completeReceiptSideEffects(db, prior);
    return { shortcode: prior.shortcode, deleted: prior.deleted };
  }

  if (!write.event) {
    const projection = expectedProjection(write);
    if (projection.entity === "meal") {
      await executeEntity(
        caldavContext(db, write.actorId, {
          meal: {
            beforeDelete: async (tx) => assertExpected(tx, projection),
            afterDelete: async (tx, ids) => {
              const entityId = ids[0];
              if (!entityId)
                throw new Error("Meal deletion did not report an entity id");
              await storeReceipt(
                write.operationId,
                "meal",
                entityId,
                "deleted",
                projection.id,
                true,
              )(tx);
            },
          },
        }),
        { action: "delete", entity: "meal", ids: [projection.id] },
      );
    } else {
      await executeEntity(
        caldavContext(db, write.actorId, {
          task: {
            beforeDelete: async (tx) => assertExpected(tx, projection),
            afterDelete: async (tx, ids) => {
              const entityId = ids[0];
              if (!entityId)
                throw new Error("Task deletion did not report an entity id");
              await storeReceipt(
                write.operationId,
                "task",
                entityId,
                "deleted",
                projection.id,
                true,
              )(tx);
            },
          },
        }),
        { action: "delete", entity: "task", ids: [projection.id] },
      );
    }
    await markReceiptSideEffectsCompleted(db, write.operationId);
    return { shortcode: projection.id, deleted: true };
  }

  const event = eventRequired(write);
  if (!write.expected) {
    rejectReservedIdentity(write.filename, event.uid);
    if (write.collection === "meals") {
      const created = await executeEntity(
        caldavContext(db, write.actorId, {
          meal: {
            afterCreate: async (tx, row) => {
              await tx.insert(calendarResourceIdentity).values({
                entityType: "meal",
                entityId: row.id,
                shortcode: row.shortcode,
                filename: write.filename,
                uid: event.uid,
              });
              await storeReceipt(
                write.operationId,
                "meal",
                row.id,
                "created",
                row.shortcode,
                false,
              )(tx);
            },
          },
        }),
        {
          action: "create",
          entity: "meal",
          data: {
            date: event.startDate,
            name: event.summary,
            mealType: event.mealType,
          },
        },
      );
      await markReceiptSideEffectsCompleted(db, write.operationId);
      return { shortcode: created.item.id, deleted: false };
    }
    const created = await executeEntity(
      caldavContext(db, write.actorId, {
        task: {
          afterCreate: async (tx, row) => {
            await tx.insert(calendarResourceIdentity).values({
              entityType: "task",
              entityId: row.id,
              shortcode: row.shortcode,
              filename: write.filename,
              uid: event.uid,
            });
            await storeReceipt(
              write.operationId,
              "task",
              row.id,
              "created",
              row.shortcode,
              false,
            )(tx);
          },
        },
      }),
      {
        action: "create",
        entity: "task",
        data: {
          name: event.summary,
          dueDate: event.startDate,
          dueEndDate: shiftDate(event.endDateExclusive, -1),
          status:
            write.collection === "completed-tasks" ? "done" : "not_started",
          trade: "other",
          projectId: null,
          subjectProductId: null,
          parentTaskId: null,
          sortOrder: null,
        },
      },
    );
    await markReceiptSideEffectsCompleted(db, write.operationId);
    return { shortcode: created.item.id, deleted: false };
  }

  const projection = expectedProjection(write);
  if (projection.entity === "meal") {
    const generatedName = projection.mealType
      ? MEAL_TYPE_LABELS[projection.mealType]
      : "Meal";
    const name =
      projection.name === null && event.summary === generatedName
        ? null
        : event.summary;
    await executeEntity(
      caldavContext(db, write.actorId, {
        meal: {
          beforeUpdate: async (tx) => assertExpected(tx, projection),
          afterUpdate: async (tx, id) =>
            storeReceipt(
              write.operationId,
              "meal",
              id,
              "updated",
              projection.id,
              false,
            )(tx),
        },
      }),
      {
        action: "update",
        entity: "meal",
        id: projection.id,
        data: { date: event.startDate, name, mealType: event.mealType },
      },
    );
  } else {
    await executeEntity(
      caldavContext(db, write.actorId, {
        task: {
          beforeUpdate: async (tx) => assertExpected(tx, projection),
          afterUpdate: async (tx, id) =>
            storeReceipt(
              write.operationId,
              "task",
              id,
              "updated",
              projection.id,
              false,
            )(tx),
        },
      }),
      {
        action: "update",
        entity: "task",
        id: projection.id,
        data: {
          name: event.summary,
          dueDate: event.startDate,
          dueEndDate: shiftDate(event.endDateExclusive, -1),
        },
      },
    );
  }
  await markReceiptSideEffectsCompleted(db, write.operationId);
  return { shortcode: projection.id, deleted: false };
}

/** DAV clients need terminal domain refusals as DAV responses, never a retryable
 * 503. The detailed Cubby reason remains in its audit/error path; DAV exposes
 * only the stable conflict/precondition distinction. */
export async function executeCalDavWrite(
  db: Database,
  write: CalDavWrite,
): Promise<CalDavWriteResult> {
  try {
    return await executeCalDavWriteUnsafe(db, write);
  } catch (error) {
    if (error instanceof CalDavError) throw error;
    // A receipt proves the entity transaction committed. Side effects may have
    // failed afterward, so this remains retryable and the DO keeps its intent
    // for receipt-based recovery instead of converting it to a terminal DAV
    // refusal.
    if (await getStoredCalDavWriteReceipt(db, write.operationId)) throw error;
    if (
      isUniqueViolation(
        error,
        "CalendarResourceIdentity_entity_filename_key",
      ) ||
      isUniqueViolation(error, "CalendarResourceIdentity_uid_key")
    ) {
      throw new CalDavError(
        409,
        "Calendar resource identity already exists",
        "no-uid-conflict",
      );
    }
    if (error instanceof AppError) {
      const missing =
        error.code === "NOT_FOUND" || error.reason.endsWith("_NOT_FOUND");
      throw new CalDavError(
        missing ? 412 : 409,
        error.message,
        missing ? "etag-mismatch" : "valid-calendar-data",
      );
    }
    throw error;
  }
}
