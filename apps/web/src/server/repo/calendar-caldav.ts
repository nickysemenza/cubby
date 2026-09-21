/** PostgreSQL half of CalDAV: canonical projections and entity-kernel writes. */
import {
  mealShortcode,
  parseShortcodeFor,
  taskShortcode,
} from "@cubby/schemas/identifiers";
import { MEAL_TYPE_LABELS } from "@cubby/schemas/meal-classification";
import { and, eq, isNotNull, or, sql } from "drizzle-orm";

import {
  type CalDavWrite,
  type CalendarProjection,
  CalDavError,
} from "~/server/calendar/caldav-types";
import { UID_DOMAIN } from "~/server/calendar/contracts";
import type { Database, DrizzleTransaction } from "~/server/db";
import { meal, task } from "~/server/db/schema";
import { executeEntity } from "~/server/entity-kernel";
import type { EntityKernelContext } from "~/server/entity-kernel";
import { notDeleted, withTransaction } from "~/server/repo/database-helpers";
import { buildCrudServices } from "~/server/request-context";

const PAGE_SIZE = 500;

const shiftDate = (value: string, days: number) => {
  const [year, month, day] = value.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined)
    throw new CalDavError(400, "Invalid calendar date");
  return new Date(Date.UTC(year, month - 1, day + days))
    .toISOString()
    .slice(0, 10);
};

const timestamp = (value: Date) => value.toISOString();

/** Full, unbounded publication snapshot for the CalDAV Durable Object. */
export async function loadCalDavProjection(
  db: Database,
): Promise<{ projections: CalendarProjection[] }> {
  return withTransaction(db, async (tx) => {
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
    return {
      projections: [
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
      ],
    };
  });
}

const caldavContext = (
  db: Database,
  actorId: CalDavWrite["actorId"],
  hooks?: EntityKernelContext["caldavHooks"],
) => {
  const context: EntityKernelContext = {
    ...buildCrudServices(db),
    readDb: db,
    actorContext: { userId: actorId, source: "caldav" },
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
export async function executeCalDavWrite(
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
        dueDate: event.startDate,
        dueEndDate: shiftDate(event.endDateExclusive, -1),
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
          dueDate: event.startDate,
          dueEndDate: shiftDate(event.endDateExclusive, -1),
        },
      },
    );
  }
  return { shortcode: projection.id };
}
