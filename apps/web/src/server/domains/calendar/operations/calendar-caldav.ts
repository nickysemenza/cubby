/** PostgreSQL half of CalDAV: canonical projections and entity-kernel writes. */
import { buildActorContext } from "@cubby/schemas/context";
import {
  mealShortcode,
  parseShortcodeFor,
  taskShortcode,
} from "@cubby/schemas/identifiers";
import { MEAL_TYPE_LABELS } from "@cubby/schemas/meal-classification";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { shiftPlainDate } from "~/lib/household-date";
import type { Database, DrizzleTransaction } from "~/server/db";
import {
  getDb,
  notDeleted,
  runBeforeCommitDatabase,
  withTransaction,
  withTransactionDatabase,
} from "~/server/db/helpers";
import { relationalSql } from "~/server/db/helpers/relational-sql";
import { auditLog, meal, task } from "~/server/db/schema";
import {
  type CalDavWrite,
  type CalendarProjection,
  CalDavError,
} from "~/server/domains/calendar/repo/caldav-types";
import { UID_DOMAIN } from "~/server/domains/calendar/repo/contracts";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { withAuditReceipts } from "~/server/generic/audit-log/repo/audit-receipts";
import { buildCrudServices } from "~/server/http/request-context";

const PAGE_SIZE = 500;

export interface CalDavCommitReceipt {
  auditId: string;
  shortcode: string;
}

/** The audit and canonical mutation share a transaction; absence is never replay permission. */
export async function hasCalDavCommitReceipt(
  db: Database,
  receipt: CalDavCommitReceipt & { entity: "meal" | "task" },
): Promise<boolean> {
  const table = receipt.entity === "meal" ? meal : task;
  // includes-deleted: a committed write still owns its DAV identity after later deletion.
  const [row] = await getDb(db)
    .select({ id: auditLog.id })
    .from(auditLog)
    .innerJoin(table, eq(auditLog.entityId, table.id))
    .where(
      and(
        eq(auditLog.id, receipt.auditId),
        eq(auditLog.channel, "caldav"),
        eq(auditLog.entityKind, receipt.entity),
        eq(table.shortcode, receipt.shortcode),
      ),
    );
  return Boolean(row);
}

export async function executeCalDavWrite(
  db: Database,
  write: CalDavWrite,
  prepareReceipt?: (receipt: CalDavCommitReceipt) => Promise<void>,
): Promise<{ shortcode: string; projection: CalendarProjection }> {
  return withTransactionDatabase(db, async (transactionDb) => {
    const { result, auditIds } = await withAuditReceipts(() =>
      mutateCalDavWrite(transactionDb, write),
    );
    const entity = write.collection === "meals" ? "meal" : "task";
    const table = entity === "meal" ? meal : task;
    const [receipt] = await getDb(transactionDb)
      .select({ auditId: auditLog.id, shortcode: table.shortcode })
      .from(auditLog)
      .innerJoin(table, eq(auditLog.entityId, table.id))
      .where(
        and(
          inArray(auditLog.id, auditIds),
          eq(auditLog.entityKind, entity),
          eq(auditLog.channel, "caldav"),
          eq(table.shortcode, result.shortcode),
        ),
      );
    // Task writers omit audit rows when no rendered fields changed. An unchanged
    // PUT needs no commit proof; creating or changing a record still requires one.
    if (!receipt && (!write.expected || auditIds.length > 0))
      throw new Error("Calendar mutation did not produce its audit receipt");
    let projection: CalendarProjection;
    if (entity === "meal") {
      const [row] = await getDb(transactionDb)
        .select({
          name: meal.name,
          date: meal.date,
          mealType: meal.mealType,
          updatedAt: meal.updatedAt,
        })
        .from(meal)
        .where(and(eq(meal.shortcode, result.shortcode), notDeleted(meal)));
      if (!row) throw new Error("Written meal is unavailable");
      projection = {
        ...row,
        entity,
        id: parseShortcodeFor("meal", result.shortcode),
        updatedAt: timestamp(row.updatedAt),
      };
    } else {
      const [row] = await getDb(transactionDb)
        .select({
          name: task.name,
          dueDate: task.dueDate,
          dueEndDate: task.dueEndDate,
          status: task.status,
          updatedAt: task.updatedAt,
        })
        .from(task)
        .where(and(eq(task.shortcode, result.shortcode), notDeleted(task)));
      if (!row) throw new Error("Written task is unavailable");
      projection = {
        ...row,
        entity,
        id: parseShortcodeFor("task", result.shortcode),
        updatedAt: timestamp(row.updatedAt),
      };
    }
    // Capture after validation/fences, but before COMMIT, including caller-owned boundaries.
    if (receipt)
      await runBeforeCommitDatabase(
        transactionDb,
        async () => {
          await prepareReceipt?.(receipt);
        },
        "publication",
      );
    return { ...result, projection };
  });
}

const shiftDate = (value: string, days: number) => {
  try {
    return shiftPlainDate(value, days);
  } catch (error) {
    if (error instanceof RangeError)
      throw new CalDavError(400, "Invalid calendar date");
    throw error;
  }
};

const timestamp = (value: Date) => value.toISOString();

/**
 * Read the full collection in one repeatable snapshot, retaining only one page.
 * The transaction intentionally spans the awaited render/staging callback so
 * concurrent writes cannot make offset pages omit or duplicate records.
 */
export async function visitCalDavProjection(
  db: Database,
  visit: (projections: CalendarProjection[]) => Promise<void>,
): Promise<void> {
  await withTransaction(
    db,
    async (tx) => {
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await tx.query.meal.findMany({
          where: {
            RAW: (table: PgTable) => relationalSql(table, notDeleted(meal)),
          },
          columns: {
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
        await visit(
          page.map((row) => ({
            entity: "meal",
            id: parseShortcodeFor("meal", row.shortcode),
            name: row.name,
            date: row.date,
            mealType: row.mealType,
            updatedAt: timestamp(row.updatedAt),
          })),
        );
        if (page.length < PAGE_SIZE) break;
      }
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const page = await tx.query.task.findMany({
          where: {
            RAW: (table: PgTable) =>
              relationalSql(
                table,
                and(
                  notDeleted(task),
                  or(isNotNull(task.dueDate), isNotNull(task.dueEndDate)),
                ),
              ),
          },
          columns: {
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
        await visit(
          page.map((row) => ({
            entity: "task",
            id: parseShortcodeFor("task", row.shortcode),
            name: row.name,
            dueDate: row.dueDate,
            dueEndDate: row.dueEndDate,
            status: row.status,
            updatedAt: timestamp(row.updatedAt),
          })),
        );
        if (page.length < PAGE_SIZE) break;
      }
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

const caldavContext = (
  db: Database,
  actorId: CalDavWrite["actorId"],
  hooks?: EntityKernelContext["caldavHooks"],
) => {
  const context: EntityKernelContext = {
    ...buildCrudServices(db),
    actorContext: buildActorContext(actorId, "caldav"),
  };
  if (hooks) context.caldavHooks = hooks;
  return context;
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

/** Lock and compare canonical liveness and rendered fields, not a stale DO ETag. */
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
    )
      throw new CalDavError(412, "Meal changed in Cubby", "etag-mismatch");
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
  )
    throw new CalDavError(412, "Task changed in Cubby", "etag-mismatch");
}

/** Client-created resources cannot claim Cubby's canonical shortcode namespace. */
function rejectReservedCalDavIdentity(filename: string, uid: string) {
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
  if (reservedFilename || reservedUid)
    throw new CalDavError(
      409,
      "Cubby calendar resource identity is reserved",
      "no-uid-conflict",
    );
}

/**
 * Creates and updates use the canonical kernel. Errors after a repository
 * transaction can be uncertain, so only explicit pre-commit CalDavErrors are
 * classified as definite DAV refusals.
 */
async function mutateCalDavWrite(
  db: Database,
  write: CalDavWrite,
): Promise<{ shortcode: string }> {
  const event = write.event;
  if (!write.expected) {
    rejectReservedCalDavIdentity(write.filename, event.uid);
    if (write.collection === "meals") {
      const created = await executeEntity(caldavContext(db, write.actorId), {
        action: "create",
        entity: "meal",
        data: {
          date: event.startDate,
          name: event.summary,
          mealType: event.mealType,
        },
      });
      return { shortcode: created.item.id };
    }
    if (!event.trade) {
      throw new CalDavError(
        422,
        "Task creation requires a valid X-CUBBY-TRADE classification. Create the task in Cubby first if your calendar cannot provide it.",
      );
    }
    const created = await executeEntity(caldavContext(db, write.actorId), {
      action: "create",
      entity: "task",
      data: {
        name: event.summary,
        due: {
          start: event.startDate,
          end: shiftDate(event.endDateExclusive, -1),
        },
        status: write.collection === "completed-tasks" ? "done" : "not_started",
        trade: event.trade,
        projectMode: "inherit",
        subjectProductMode: "inherit",
        projectId: null,
        subjectProductId: null,
        parentTaskId: null,
        sortOrder: null,
      },
    });
    return { shortcode: created.item.id };
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
        meal: { beforeUpdate: async (tx) => assertExpected(tx, projection) },
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
        task: { beforeUpdate: async (tx) => assertExpected(tx, projection) },
      }),
      {
        action: "update",
        entity: "task",
        id: projection.id,
        data: {
          name: event.summary,
          due: {
            start: event.startDate,
            end: shiftDate(event.endDateExclusive, -1),
          },
        },
      },
    );
  }
  return { shortcode: projection.id };
}
