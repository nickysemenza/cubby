import type { ProjectId } from "@cubby/schemas/identifiers";
import type {
  ExpenseFilters,
  ProjectDashboardFilters,
  ProjectFilters,
} from "@cubby/schemas/project";
import { and, eq, inArray, type SQL, sql } from "drizzle-orm";
import type { AnyPgColumn, PgTable } from "drizzle-orm/pg-core";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { effectiveFieldSql } from "~/server/db/computed/effective-field";
import { getDb, uuidArrayParam } from "~/server/db/helpers";
import {
  expense as expenseTable,
  ingredient as ingredientTable,
  project as projectTable,
  task as taskTable,
} from "~/server/db/schema";
import { getEntityCounts } from "~/server/domains/dashboard/repo/dashboard";
import {
  expenseDerivedReadSql,
  prepareExpenseDerivedRead,
} from "~/server/domains/expense/repo/expense-derived-read";
import { expenseScaffold } from "~/server/domains/expense/repo/lookup";
import { buildDashboardProjectWhere } from "~/server/domains/project/repo/dashboard-shared";
import {
  loadProjectDateWindows,
  projectCompletionYear,
} from "~/server/domains/project/repo/subtree";
import { taskScaffold } from "~/server/domains/task/repo/lookup";
import { entityKernelContextSchema } from "~/server/entity-kernel";
import { listOperations } from "~/server/entity-kernel/list-operations";
import type { ListFilterValues } from "~/server/generic/list/repo/field-compiler";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { drainStoredDerived } from "~/server/testing/background-queue";
import { createTestRequestContext } from "~/server/testing/request-context";

/**
 * Declared list scopes (plan §3.6, #2610). A list's static scope
 * (`presentation.list.scope`) and a project page's embedded scope (a nested
 * project filter record, `presentation.list.scopes`) compile into
 * `scaffold.where`, so no repository ANDs them. Failure modes:
 * - an ingredient list, search or count shows a recipe's own ingredient row;
 * - an embedded project scope misses a task that inherits its project from a
 *   parent or grandparent task, or a sub-project the scope's filters select;
 * - an expense scope reads the line's own project instead of its allocation
 *   shares (a fee shared onto a scoped project), or analytics count other
 *   expenses than the list;
 * - a nested key the old scope spelled differently is dropped silently.
 * Each scope case runs the retired composition (the dashboard project where,
 * then the effective task project or any allocation share) beside the
 * compiled scope over one synthetic fixture.
 */
describe("declared list scopes", () => {
  const ctx = withTestDb();
  const db = () => ctx.db;
  const page = { pageIndex: 0, pageSize: 100 };
  const sorted = (ids: Iterable<string>) => [...ids].sort();
  const context = () =>
    entityKernelContextSchema.parse(
      createTestRequestContext(ctx.db, { auth: { userId: ctx.actor.userId } }),
    );
  const listed = async (
    entity: "ingredient" | "task" | "expense",
    filters: ListFilterValues,
  ) => {
    const pageResult = await listOperations(entity).listFields(
      context(),
      {
        filters,
        pagination: page,
      },
      ["id"],
    );
    return sorted(pageResult.items.map((row) => row.id));
  };
  /** Codes of `rows` matching `where`, sorted. */
  const matching = async (
    table: PgTable & { id: AnyPgColumn; shortcode: AnyPgColumn },
    rows: readonly { id: string }[],
    where: SQL | undefined,
  ) =>
    sorted(
      (
        await getDb(db())
          .select({ code: table.shortcode })
          .from(table)
          .where(
            and(
              inArray(
                table.id,
                rows.map((row) => row.id),
              ),
              where,
            ),
          )
      ).map((row) => String(row.code)),
    );
  const codes = (...rows: { shortcode: string }[]) =>
    sorted(rows.map((row) => row.shortcode));

  it("never lists, finds or counts a recipe's own ingredient row", async () => {
    const recipe = await insertWithShortcode(db(), "recipe", {
      name: "Zqscope pesto",
    });
    const standalone = await insertWithShortcode(db(), "ingredient", {
      name: "Zqscope basil",
    });
    const owned = await insertWithShortcode(db(), "ingredient", {
      name: "Zqscope pesto",
      recipeId: recipe.id as never,
    });
    expect(await listed("ingredient", { nameFilter: "zqscope" })).toEqual([
      standalone.shortcode,
    ]);
    // The same row requested by id stays out: a request cannot lift the scope.
    expect(
      await listed("ingredient", {
        ids: [owned.shortcode, standalone.shortcode],
      }),
    ).toEqual([standalone.shortcode]);
    const [live] = await getDb(db())
      .select({ count: sql<number>`count(*)::int` })
      .from(ingredientTable)
      .where(
        sql`${ingredientTable.deletedAt} IS NULL AND ${ingredientTable.recipeId} IS NULL`,
      );
    expect((await getEntityCounts(db())).ingredient).toBe(live?.count);
  });

  /**
   * The retired `matchingEmbeddedProjectIds`: the dashboard's project where
   * over the old scope keys, with completion years from the subtree fold.
   */
  const retiredScopeProjects = async (
    scope: Omit<ProjectDashboardFilters, "statusScope"> & {
      statuses?: ProjectDashboardFilters["statusScope"];
    },
  ): Promise<ProjectId[]> => {
    const dated = scope.completionYear
      ? await loadProjectDateWindows(db())
      : null;
    const completionIds = dated?.tree.allRows
      .filter((row) => {
        const window = dated.dateWindows.get(row.id);
        return (
          window && projectCompletionYear(row, window) === scope.completionYear
        );
      })
      .map((row) => row.id);
    const rows = await getDb(db())
      .select({ id: projectTable.id })
      .from(projectTable)
      .where(
        buildDashboardProjectWhere(
          { ...scope, statusScope: scope.statuses },
          completionIds,
        ),
      );
    return rows.map((row) => row.id);
  };

  /**
   * Scope cases: the old record, the project list filter record that
   * replaces it, and the task fixture names both select.
   */
  type ScopeCase = readonly [
    old: Parameters<typeof retiredScopeProjects>[0],
    scope: ProjectFilters,
  ];

  const projectFixture = async () => {
    const insert = (
      name: string,
      values: {
        kind: "garden" | "renovation";
        status: "planning" | "not_started" | "in_progress" | "done";
        parent?: { id: string };
        locations?: string[];
        notes?: string;
        startDate?: string;
        endDate?: string;
      },
    ) =>
      insertWithShortcode(db(), "project", {
        name,
        kind: values.kind,
        status: values.status,
        notes: values.notes ?? null,
        parentProjectId: (values.parent?.id ?? null) as never,
        locationsMode: values.locations === undefined ? "inherit" : "explicit",
        locations: values.locations ?? [],
        startDate: values.startDate ?? null,
        endDate: values.endDate ?? null,
        defaultTrade: "other",
      });
    const beds = await insert("Zqscope raised beds", {
      kind: "garden",
      status: "in_progress",
      locations: ["Zqscope yard"],
      startDate: "2026-04-01",
      endDate: "2026-05-01",
    });
    // Sub-projects inherit the parent's locations.
    const seedlings = await insert("Zqscope seedlings", {
      kind: "garden",
      status: "planning",
      parent: beds,
    });
    const fence = await insert("Zqscope fence", {
      kind: "renovation",
      status: "done",
      parent: beds,
      notes: "Posts beside the raised beds",
      startDate: "2025-07-01",
      endDate: "2025-08-01",
    });
    const kitchen = await insert("Zqscope kitchen", {
      kind: "renovation",
      status: "not_started",
      locations: ["Kitchen"],
    });
    return { beds, seedlings, fence, kitchen };
  };

  const cases: readonly ScopeCase[] = [
    [{ kinds: ["garden"] }, { kind: ["garden"] }],
    [{ statuses: ["done"] }, { status: ["done"] }],
    [{ locations: ["Zqscope yard"] }, { location: ["Zqscope yard"] }],
    [{ search: "Zqscope raised" }, { search: "Zqscope raised" }],
    [
      { dateFrom: "2026-04-10", dateTo: "2026-04-20" },
      { dateFrom: "2026-04-10", dateTo: "2026-04-20" },
    ],
    [{ completionYear: "2025" }, { completionYear: "2025" }],
    [
      { kinds: ["renovation"], statuses: ["not_started"] },
      { kind: ["renovation"], status: ["not_started"] },
    ],
  ];

  it("matches a project page's tasks through their effective project", async () => {
    const { beds, seedlings, fence, kitchen } = await projectFixture();
    const insert = (
      name: string,
      values: { project?: { id: string } | null; parent?: { id: string } },
    ) =>
      insertWithShortcode(db(), "task", {
        name,
        parentTaskId: (values.parent?.id ?? null) as never,
        projectMode: values.project === undefined ? "inherit" : "explicit",
        projectId: (values.project?.id ?? null) as never,
        assigneeMode: "inherit",
        subjectProductMode: "inherit",
        trade: "other",
      });
    const own = await insert("Zqscope dig beds", { project: beds });
    // One and two levels below a task that sets the project.
    const child = await insert("Zqscope edge beds", { parent: own });
    const grandchild = await insert("Zqscope buy edging", { parent: child });
    const sub = await insert("Zqscope sow trays", { project: seedlings });
    const posts = await insert("Zqscope set posts", { project: fence });
    const cabinets = await insert("Zqscope order cabinets", {
      project: kitchen,
    });
    const loose = await insert("Zqscope loose task", { project: null });
    const rows = [own, child, grandchild, sub, posts, cabinets, loose];
    const retired = async (old: ScopeCase[0]) =>
      sql`${effectiveFieldSql("task", "projectId")} = ANY(${uuidArrayParam(
        await retiredScopeProjects(old),
      )})`;
    await drainStoredDerived(ctx.db);
    const actual = [];
    const expected = [];
    for (const [old, scope] of cases) {
      const before = await matching(taskTable, rows, await retired(old));
      expected.push({ scope, rows: before });
      actual.push({
        scope,
        rows: await matching(
          taskTable,
          rows,
          await taskScaffold.prepareWhere(db(), { projectScope: scope }),
        ),
      });
    }
    expect(actual).toEqual(expected);
    // Pinned, so an equivalence over empty sets cannot pass.
    expect(expected.map(({ rows }) => rows)).toEqual([
      codes(own, child, grandchild, sub),
      codes(posts),
      codes(own, child, grandchild, sub, posts),
      codes(own, child, grandchild),
      codes(own, child, grandchild),
      codes(posts),
      codes(cabinets),
    ]);
    // Behavior change (plan §8): the scope's search is the project list's,
    // matching notes and effective locations beside the name.
    expect(
      await matching(
        taskTable,
        rows,
        await retired({ search: "zqscope yard" }),
      ),
    ).toEqual([]);
    expect(
      await matching(
        taskTable,
        rows,
        await taskScaffold.prepareWhere(db(), {
          projectScope: { search: "zqscope yard" },
        }),
      ),
    ).toEqual(codes(own, child, grandchild, sub, posts));
    expect(
      await matching(
        taskTable,
        rows,
        await taskScaffold.prepareWhere(db(), {
          projectScope: { search: "raised beds" },
        }),
      ),
    ).toEqual(codes(own, child, grandchild, posts));
    // A scope that selects no live project matches no task: neither one
    // selecting nothing nor one whose only match is soft-deleted lifts it.
    const gone = await insertWithShortcode(db(), "project", {
      name: "Zqscope retired trip",
      kind: "trip",
      status: "done",
      locationsMode: "inherit",
      locations: [],
      defaultTrade: "other",
    });
    const stranded = await insert("Zqscope pack bags", { project: gone });
    await getDb(db())
      .update(projectTable)
      .set({ deletedAt: new Date() })
      .where(eq(projectTable.id, gone.id));
    for (const scope of [
      { kind: ["trip"] },
      { search: "zqscope nothing" },
    ] satisfies ProjectFilters[])
      expect({
        scope,
        rows: await matching(
          taskTable,
          [...rows, stranded],
          await taskScaffold.prepareWhere(db(), { projectScope: scope }),
        ),
      }).toEqual({ scope, rows: [] });
    // End to end, beside an ordinary task filter.
    expect(
      (
        await listed("task", {
          projectScope: { kind: ["garden"] },
          topLevelOnly: true,
        })
      ).filter((code) => rows.some((row) => row.shortcode === code)),
    ).toEqual(codes(own, sub));
  });

  it("matches a project page's expenses through any allocation share", async () => {
    const { beds, seedlings, kitchen } = await projectFixture();
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Zqscope supply vendor",
    });
    const order = await createRepoEntity(ctx, "purchase", {
      vendorId: vendor.output.id,
      date: "2026-04-12",
    });
    const line = async (
      name: string,
      values: {
        project?: { shortcode: string };
        fee?: boolean;
        order?: boolean;
      },
    ) =>
      (
        await createRepoEntity(ctx, "expense", {
          name,
          cost: values.fee ? 4 : 40,
          date: "2026-04-12",
          lineKind: values.fee ? "fee" : "principal",
          costType: values.fee ? "services" : "materials",
          trade: values.fee ? null : "other",
          future: false,
          ...(values.project === undefined
            ? {}
            : { projectId: values.project.shortcode as never }),
          ...(values.order ? { purchaseId: order.output.id } : {}),
        })
      ).output;
    const lumber = await line("Zqscope lumber", { project: beds });
    // One order: a principal on the sub-project, one unassigned, and a fee
    // whose shares follow both.
    const trays = await line("Zqscope trays", {
      project: seedlings,
      order: true,
    });
    const gloves = await line("Zqscope gloves", { order: true });
    const shipping = await line("Zqscope shipping", { fee: true, order: true });
    const tiles = await line("Zqscope tiles", { project: kitchen });
    const fixture = [lumber, trays, gloves, shipping, tiles];
    const rows = await getDb(db())
      .select({ id: expenseTable.id, shortcode: expenseTable.shortcode })
      .from(expenseTable)
      .where(
        inArray(
          expenseTable.shortcode,
          fixture.map((row) => row.id),
        ),
      );
    const retired = async (old: ScopeCase[0]) =>
      sql`${expenseTable.id} IN (SELECT share."expenseId" FROM (${expenseDerivedReadSql(
        "shares",
      )}) share WHERE share."projectId" = ANY(${uuidArrayParam(
        await retiredScopeProjects(old),
      )}))`;
    const actual = [];
    const expected = [];
    for (const [old, scope] of cases) {
      expected.push({
        scope,
        rows: await matching(expenseTable, rows, await retired(old)),
      });
      actual.push({
        scope,
        rows: await matching(
          expenseTable,
          rows,
          await expenseScaffold.prepareWhere(db(), { projectScope: scope }),
        ),
      });
    }
    expect(actual).toEqual(expected);
    const code = (...lines: { id: string }[]) => sorted(lines.map((l) => l.id));
    expect(expected[0]?.rows).toEqual(code(lumber, trays, shipping));
    // Beside a row filter and share filters, the scope still reads the
    // whole expense's shares.
    const filters: ExpenseFilters[] = [
      { projectScope: { kind: ["garden"] } },
      { projectScope: { kind: ["garden"] }, lineKind: ["fee"] },
      { projectScope: { kind: ["garden"] }, projectPresenceFilter: "none" },
      { projectScope: { kind: ["renovation"] }, costType: ["materials"] },
    ];
    const inFixture = (ids: string[]) =>
      ids.filter((id) => fixture.some((row) => row.id === id));
    expect(
      await Promise.all(
        filters.map(async (each) => inFixture(await listed("expense", each))),
      ),
    ).toEqual([
      code(lumber, trays, shipping),
      code(shipping),
      // The fee's unassigned share; it also has a scoped share.
      code(shipping),
      code(tiles),
    ]);
    // Analytics select the expenses the list does.
    for (const each of filters) {
      const read = await prepareExpenseDerivedRead(db(), each);
      const counted = await read
        .select({ id: expenseTable.shortcode })
        .where(read.where);
      expect({
        filters: each,
        ids: inFixture(sorted(counted.map((row) => row.id))),
      }).toEqual({
        filters: each,
        ids: inFixture(await listed("expense", each)),
      });
    }
  });
});
