import { and, asc, eq, exists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb, notDeleted } from "~/server/db/helpers";
import { email, task } from "~/server/db/schema";
import { projectScaffold } from "~/server/domains/project/repo/lookup";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { publishQualityFixtures } from "~/server/testing/quality.fixtures";

import { listScaffold } from "./list";

/** Failure modes: correlated filters/sorts disagree with count, relation loading
 * loses page order, deleted rows leak, or count/empty reads load graphs. A
 * window count has no row on an out-of-range page, which must retain its total. */
describe("list selection and relation loading", () => {
  const ctx = withTestDb();
  const scaffold = listScaffold("task", task, {
    derived: {
      effectiveTrade: sql`NULL`,
      effectiveDueDate: sql`NULL`,
      completion: sql`NULL`,
      topLevel: sql`true`,
    },
    scopes: { projectScope: () => projectScaffold },
  });

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
    const where = and(
      scaffold.where({}),
      exists(
        getDb(ctx.db)
          .select({ id: parentTable.id })
          .from(parentTable)
          .where(eq(parentTable.id, task.parentTaskId)),
      ),
    );
    const read = async (readIntent: "page" | "count", pageIndex = 0) => {
      const page = await scaffold.raw(
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
        },
      );
      return {
        ...page,
        data: page.data.map((row) => ({
          name: row.name,
          parent: row.parentTask?.name,
        })),
      };
    };
    expect(await read("page")).toEqual({
      count: 2,
      data: [
        { name: "Test Alpha", parent: "Test Parent" },
        { name: "Test Zulu", parent: "Test Parent" },
      ],
    });
    expect(await read("count")).toEqual({ count: 2, data: [] });
    expect(await read("page", 5)).toEqual({ count: 2, data: [] });
    expect(
      await scaffold.raw(
        ctx.db,
        { filters: {}, sorts: [], pagination: { pageIndex: 0, pageSize: 2 } },
        {
          where: sql`FALSE`,
          load: async () => {
            throw new Error("An empty list must not load a graph");
          },
        },
      ),
    ).toEqual({ count: 0, data: [] });
  });

  it("counts an aliased table through its real FROM relation", async () => {
    await insertWithShortcode(ctx.db, "task", { name: "Test Aliased Task" });
    const table = alias(task, "listed_task");
    const page = await listScaffold("task", table, {
      derived: {
        effectiveTrade: sql`NULL`,
        effectiveDueDate: sql`NULL`,
        completion: sql`NULL`,
        topLevel: sql`true`,
      },
      scopes: { projectScope: () => projectScaffold },
    }).raw(
      ctx.db,
      { filters: {}, sorts: [], pagination: { pageIndex: 0, pageSize: 2 } },
      { where: notDeleted(table) },
    );
    expect(page.count).toBe(1);
    expect(page.data.map((row) => row.name)).toEqual(["Test Aliased Task"]);
  });

  it("keeps quality aliases and exact totals when loading an ordered page", async () => {
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      kind: "member",
      name: "Synthetic quality reader",
      userId: ctx.actor.userId,
    });
    for (let index = 0; index < 3; index++)
      await insertWithShortcode(ctx.db, "email", {
        ledgerPartyId: party.id,
        mailboxId: "synthetic-quality-reader",
        messageId: `synthetic-quality-${index}`,
        checksum: "a".repeat(64),
        classification: index === 0 ? "uncertain" : "related",
        classificationStage: "decision",
        status: "pending",
      });
    await publishQualityFixtures(ctx.db, "email");
    const reader = listScaffold("email", email, {
      derived: {
        linkState: sql`0`,
        scopeLinkState: sql`NULL`,
        linked: sql`false`,
        reviewConflict: sql`false`,
        purchaseId: () => undefined,
        vendorId: () => undefined,
        vendorAccountId: () => undefined,
      },
    });
    for (const pageIndex of [0, 1, 4]) {
      const request = {
        filters: { dataGap: ["email_original_missing"] },
        sorts: [{ orderBy: "dataQuality", direction: "asc" as const }],
        pagination: { pageIndex, pageSize: 2 },
      };
      const expected = await reader.raw(ctx.db, request, {});
      const actual = await reader.raw(ctx.db, request, {
        load: (where) => getDb(ctx.db).select().from(email).where(where),
      });
      expect({
        ...actual,
        data: actual.data.map((row) => row.shortcode),
      }).toEqual({
        ...expected,
        data: expected.data.map((row) => row.shortcode),
      });
      expect(actual.count).toBe(3);
    }
  });
});
