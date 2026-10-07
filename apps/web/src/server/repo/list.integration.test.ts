import { asc, eq, exists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { task } from "~/server/db/schema";
import { getDb, notDeleted } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";

import { listScaffold } from "./list";

/** Failure modes: correlated filters/sorts disagree with count, relation loading
 * loses page order, deleted rows leak, or count/empty reads load graphs. */
describe("list selection and relation loading", () => {
  const ctx = withTestDb();
  const scaffold = listScaffold("task", task);

  it("uses one FROM context and preserves the selected order across graph loading", async () => {
    const parent = await insertWithShortcode(ctx.db, "task", {
      name: "Test Parent",
    });
    for (const name of ["Test Zulu", "Test Alpha", "Test Deleted"]) {
      const child = await insertWithShortcode(ctx.db, "task", {
        name,
        parentTaskId: parent.id,
      });
      if (name === "Test Deleted")
        await getDb(ctx.db)
          .update(task)
          .set({ deletedAt: new Date() })
          .where(eq(task.id, child.id));
    }
    const parentTable = alias(task, "parent");
    const where = scaffold.where({}, [
      exists(
        getDb(ctx.db)
          .select({ id: parentTable.id })
          .from(parentTable)
          .where(eq(parentTable.id, task.parentTaskId)),
      ),
    ]);
    const read = (readIntent: "page" | "count", pageIndex = 0) =>
      scaffold.list(
        ctx.db,
        {
          filters: {},
          sorts: [],
          pagination: { pageIndex, pageSize: 2 },
          readIntent,
        },
        {
          where,
          orderBy: [
            sql`(SELECT p.name FROM "Task" p WHERE p.id = ${task.parentTaskId}) asc`,
            asc(task.name),
          ],
          load: async (where) =>
            (
              await getDb(ctx.db).query.task.findMany({
                where,
                with: { parentTask: true },
              })
            ).reverse(),
          hydrate: (rows) =>
            rows.map((row) => ({
              name: row.name,
              parent: row.parentTask?.name,
            })),
        },
      );
    const page = await countTestDbQueries(() => read("page"));
    expect(page.result).toEqual({
      count: 2,
      data: [
        { name: "Test Alpha", parent: "Test Parent" },
        { name: "Test Zulu", parent: "Test Parent" },
      ],
    });
    expect(page.queryCount).toBe(3);
    const count = await countTestDbQueries(() => read("count"));
    expect(count.result).toEqual({ count: 2, data: [] });
    expect(count.queryCount).toBe(1);
    const empty = await countTestDbQueries(() => read("page", 5));
    expect(empty.result).toEqual({ count: 2, data: [] });
    expect(empty.queryCount).toBe(2);
  });

  it("counts an aliased table through its real FROM relation", async () => {
    await insertWithShortcode(ctx.db, "task", { name: "Test Aliased Task" });
    const table = alias(task, "listed_task");
    const page = await listScaffold("task", table).list(
      ctx.db,
      { filters: {}, sorts: [], pagination: { pageIndex: 0, pageSize: 2 } },
      { where: notDeleted(table), hydrate: (rows) => rows },
    );
    expect(page.count).toBe(1);
    expect(page.data.map((row) => row.name)).toEqual(["Test Aliased Task"]);
  });
});
