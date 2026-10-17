import { eq } from "drizzle-orm";
import { taxonomyId } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { task as taskTable } from "~/server/db/schema";
import { inventoryentryList } from "~/server/domains/inventory/repo/crud";
import { listProductCategories } from "~/server/domains/product-category/repo/product-category";
import { productList } from "~/server/domains/product/repo/crud";
import { projectList } from "~/server/domains/project/repo/lookup";
import { taskList } from "~/server/domains/task/repo/lookup";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

const page = { pageIndex: 0, pageSize: 100 };

/**
 * Inherited values (`resolution.inherit`) compile one effective value for
 * reads, filters, sorts and groups. Each case's expected rows are the ones
 * the hand-written predicates returned before the declaration replaced them
 * (plan rows 19–26), except the task rows named as intended changes.
 * Failure modes: a task field stops at the parent instead of the nearest
 * deciding ancestor; a task assignee skips its effective project default
 * or an explicit None default; a deleted parent still donates; project and
 * category walks stop at the parent or ignore an explicit None (`blocked`);
 * Exclude drops rows with no value; a read, its provenance, and its filter
 * disagree.
 */
describe("inherited values", () => {
  const ctx = withTestDb();
  const db = () => ctx.db;

  const projectWorld = async () => {
    const member = (name: string) =>
      insertWithShortcode(db(), "ledgerParty", { name, kind: "member" });
    const a = await member("Inherit member A");
    const b = await member("Inherit member B");
    type ProjectRow = Awaited<ReturnType<typeof insertProject>>;
    const insertProject = (
      name: string,
      values: {
        parent?: { id: string };
        assignee?: { id: string } | null;
        locations?: string[];
      },
    ) =>
      insertWithShortcode(db(), "project", {
        name,
        parentProjectId: (values.parent?.id ?? null) as never,
        assigneeMode: values.assignee === undefined ? "inherit" : "explicit",
        assigneeId: (values.assignee?.id ?? null) as never,
        locationsMode: values.locations === undefined ? "inherit" : "explicit",
        locations: values.locations ?? [],
        defaultTrade: "other",
      });
    const p1 = await insertProject("Inherit P1", {
      assignee: a,
      locations: ["Inherit garage"],
    });
    const p2 = await insertProject("Inherit P2", { parent: p1 });
    const p3 = await insertProject("Inherit P3", {
      assignee: null,
      locations: [],
    });
    const p4 = await insertProject("Inherit P4", {});
    const p5 = await insertProject("Inherit P5", { parent: p3 });
    const p6 = await insertProject("Inherit P6", { parent: p2 });
    const p7 = await insertProject("Inherit P7", {
      parent: p1,
      assignee: b,
      locations: ["Inherit shed"],
    });
    const projects: ProjectRow[] = [p1, p2, p3, p4, p5, p6, p7];
    return { a, b, p1, p2, p3, p4, p5, p6, p7, projects };
  };

  it("filters projects by their inherited assignee and locations", async () => {
    const w = await projectWorld();
    const ids = new Set(w.projects.map((row) => row.shortcode));
    const listed = async (filters: Parameters<typeof projectList>[1]) =>
      (await projectList(db(), filters, [], page)).data
        .map((row) => row.id)
        .filter((id) => ids.has(id))
        .sort();
    const codes = (...rows: { shortcode: string }[]) =>
      rows.map((row) => row.shortcode).sort();
    const cases: Array<[Parameters<typeof projectList>[1], string[]]> = [
      [{ assigneeId: [w.a.shortcode] }, codes(w.p1, w.p2, w.p6)],
      [{ assigneeId: [w.b.shortcode] }, codes(w.p7)],
      [{ assigneeIdPresenceFilter: "none" }, codes(w.p3, w.p4, w.p5)],
      [{ assigneeIdPresenceFilter: "has" }, codes(w.p1, w.p2, w.p6, w.p7)],
      [{ assigneeIdExclude: [w.a.shortcode] }, codes(w.p3, w.p4, w.p5, w.p7)],
      [{ location: ["Inherit garage"] }, codes(w.p1, w.p2, w.p6)],
      [{ location: ["Inherit shed"] }, codes(w.p7)],
      [{ locationsExclude: ["Inherit garage"] }, codes(w.p3, w.p4, w.p5, w.p7)],
    ];
    for (const [filters, expected] of cases)
      expect({ filters, ids: await listed(filters) }).toEqual({
        filters,
        ids: expected,
      });
  });

  it("reads, explains and filters tasks by the nearest deciding ancestor", async () => {
    const w = await projectWorld();
    const subject = await createProductFixture(
      db(),
      makeProductInput({ name: "Inherit subject" }),
      ctx.actor,
    );
    type Mode = "inherit" | "explicit";
    const insertTask = (
      name: string,
      values: {
        parent?: { id: string };
        project?: [Mode, { id: string } | null];
        assignee?: [Mode, { id: string } | null];
        subject?: [Mode, { id: string } | null];
      },
    ) =>
      insertWithShortcode(db(), "task", {
        name,
        parentTaskId: (values.parent?.id ?? null) as never,
        projectMode: values.project?.[0] ?? "inherit",
        projectId: (values.project?.[1]?.id ?? null) as never,
        assigneeMode: values.assignee?.[0] ?? "inherit",
        assigneeId: (values.assignee?.[1]?.id ?? null) as never,
        subjectProductMode: values.subject?.[0] ?? "inherit",
        subjectProductId: (values.subject?.[1]?.id ?? null) as never,
        trade: "other",
      });
    const x = { id: subject.entityId };
    const t1 = await insertTask("Inherit T1", {
      project: ["explicit", w.p2],
      subject: ["explicit", x],
    });
    const t2 = await insertTask("Inherit T2", { parent: t1 });
    const t3 = await insertTask("Inherit T3", { parent: t2 });
    const t4 = await insertTask("Inherit T4", {
      parent: t1,
      project: ["explicit", w.p3],
    });
    const t5p = await insertTask("Inherit T5p", {
      project: ["explicit", w.p3],
    });
    const t5 = await insertTask("Inherit T5", {
      parent: t5p,
      project: ["explicit", w.p1],
    });
    const t6 = await insertTask("Inherit T6", {
      parent: t1,
      assignee: ["explicit", w.b],
    });
    const t7 = await insertTask("Inherit T7", {
      project: ["explicit", w.p1],
      assignee: ["explicit", null],
    });
    const t8 = await insertTask("Inherit T8", { parent: t6 });
    const t9 = await insertTask("Inherit T9", {
      project: ["explicit", w.p4],
    });
    // A stored project in inherit mode still wins (explicitIfSet).
    const t10 = await insertTask("Inherit T10", {
      parent: t1,
      project: ["inherit", w.p7],
    });
    const gone = await insertTask("Inherit deleted parent", {
      project: ["explicit", w.p1],
      assignee: ["explicit", w.b],
      subject: ["explicit", x],
    });
    await getDb(db())
      .update(taskTable)
      .set({ deletedAt: new Date() })
      .where(eq(taskTable.id, gone.id));
    const t11 = await insertTask("Inherit T11", { parent: gone });
    const t12 = await insertTask("Inherit T12", {
      project: ["explicit", w.p6],
    });
    const tasks = [t1, t2, t3, t4, t5p, t5, t6, t7, t8, t9, t10, t11, t12];
    const ids = new Set(tasks.map((row) => row.shortcode));
    const listed = async (filters: Parameters<typeof taskList>[1]) =>
      (await taskList(db(), filters, [], page)).data.filter((row) =>
        ids.has(row.id),
      );
    const listedIds = async (filters: Parameters<typeof taskList>[1]) =>
      (await listed(filters)).map((row) => row.id).sort();
    const codes = (...rows: { shortcode: string }[]) =>
      rows.map((row) => row.shortcode).sort();
    const product = subject.id;
    const effective = new Map(
      (await listed({})).map((row) => [
        row.id,
        [row.projectId, row.assigneeId, row.subjectProductId],
      ]),
    );
    const { a, b, p1, p2, p3, p4, p6, p7 } = w;
    // Each task field reads the nearest ancestor task that sets its own
    // value; the assignee then falls back to the task's effective project
    // default. Rows marked "changed" are the intended differences from the
    // old one-level chains (#2606); every other row reads as before.
    expect(Object.fromEntries(effective)).toEqual({
      [t1.shortcode]: [p2.shortcode, a.shortcode, product],
      [t2.shortcode]: [p2.shortcode, a.shortcode, product],
      // Changed: a grandchild under an inheriting parent reads the
      // grandparent's project and product (was none).
      [t3.shortcode]: [p2.shortcode, a.shortcode, product],
      // Changed: parent and child on different projects; the child's own
      // project default (an explicit None) decides, not the parent's.
      [t4.shortcode]: [p3.shortcode, null, product],
      [t5p.shortcode]: [p3.shortcode, null, null],
      // Changed: the parent's project None no longer blocks the child's
      // own project default.
      [t5.shortcode]: [p1.shortcode, a.shortcode, null],
      [t6.shortcode]: [p2.shortcode, b.shortcode, product],
      [t7.shortcode]: [p1.shortcode, null, null],
      // Changed: a grandchild under an inheriting parent (was none).
      [t8.shortcode]: [p2.shortcode, b.shortcode, product],
      [t9.shortcode]: [p4.shortcode, null, null],
      // Changed: its own project P7's default, not the parent's P2's.
      [t10.shortcode]: [p7.shortcode, b.shortcode, product],
      // A deleted parent donates nothing.
      [t11.shortcode]: [null, null, null],
      [t12.shortcode]: [p6.shortcode, a.shortcode, null],
    });
    // Provenance names the record that decided, from the same rule.
    const resolutions = new Map(
      (await listed({})).map((row) => [row.id, row.fieldResolutions]),
    );
    expect(resolutions.get(t3.shortcode)?.projectId).toMatchObject({
      mode: "inherit",
      source: "Ancestor task",
      sourceEntity: { entityKind: "task", entityId: t1.shortcode },
      value: p2.shortcode,
      fallbackValue: p2.shortcode,
    });
    expect(resolutions.get(t8.shortcode)?.assigneeId).toMatchObject({
      source: "Parent task",
      sourceEntity: { entityKind: "task", entityId: t6.shortcode },
    });
    expect(resolutions.get(t5.shortcode)?.assigneeId).toMatchObject({
      source: "Project default",
      sourceEntity: { entityKind: "project", entityId: p1.shortcode },
      value: a.shortcode,
    });
    expect(resolutions.get(t11.shortcode)?.projectId).toMatchObject({
      source: "Unassigned",
      sourceEntity: null,
    });
    const cases: Array<[Parameters<typeof taskList>[1], string[]]> = [
      [{ assigneeId: [a.shortcode] }, codes(t1, t2, t3, t5, t12)],
      [{ assigneeId: [b.shortcode] }, codes(t6, t8, t10)],
      [{ assigneeIdPresenceFilter: "none" }, codes(t4, t5p, t7, t9, t11)],
      [
        { assigneeIdExclude: [a.shortcode] },
        codes(t4, t5p, t6, t7, t8, t9, t10, t11),
      ],
      [
        { projectId: [p1.shortcode] },
        codes(t1, t2, t3, t5, t6, t7, t8, t10, t12),
      ],
      [{ projectId: [p1.shortcode], includeSubProjects: false }, codes(t5, t7)],
      [{ projectIdPresenceFilter: "none" }, codes(t11)],
      [
        { projectIdExclude: [p2.shortcode] },
        codes(t4, t5p, t5, t7, t9, t10, t11),
      ],
      [{ subjectProductId: [product] }, codes(t1, t2, t3, t4, t6, t8, t10)],
      [
        { subjectProductIdPresenceFilter: "none" },
        codes(t5p, t5, t7, t9, t11, t12),
      ],
      [
        { subjectProductIdExclude: [product] },
        codes(t5p, t5, t7, t9, t11, t12),
      ],
    ];
    for (const [filters, expected] of cases)
      expect({ filters, ids: await listedIds(filters) }).toEqual({
        filters,
        ids: expected,
      });
  });

  it("filters categories, products and inventory by inherited category values", async () => {
    const spending = (name: string, parentId: string | null = null) =>
      insertWithShortcode(db(), "spendingCategory", {
        name,
        parentId: parentId as never,
      });
    const s1 = await spending("Inherit S1");
    const s1c = await spending("Inherit S1 child", s1.id);
    const category = (
      name: string,
      values: {
        parent?: { id: string };
        spending?: { id: string } | "blocked";
      },
    ) =>
      insertWithShortcode(db(), "productCategory", {
        name,
        parentId: (values.parent?.id ?? null) as never,
        feature: null,
        spendingCategoryMode:
          values.spending === undefined
            ? "inherit"
            : values.spending === "blocked"
              ? "blocked"
              : "mapped",
        spendingCategoryId: (typeof values.spending === "object"
          ? values.spending.id
          : null) as never,
      });
    // Features are unique per live category, so the walks start below the
    // seeded Food and Tools roots (a tree is at most three levels deep).
    const food = { id: taxonomyId("food") };
    const tools = { id: taxonomyId("tools") };
    const c1 = await category("Inherit C1", { parent: food, spending: s1 });
    const c2 = await category("Inherit C2", { parent: c1 });
    // Past the declared depth: Food is three levels up, so no feature.
    const c3 = await category("Inherit C3", { parent: c2 });
    const c4 = await category("Inherit C4", {
      parent: tools,
      spending: "blocked",
    });
    const c5 = await category("Inherit C5", {});
    const c6 = await category("Inherit C6", { parent: c4 });
    const c7 = await category("Inherit C7", { parent: c1, spending: s1c });
    const categories = [c1, c2, c3, c4, c5, c6, c7];
    const categoryIds = new Set(categories.map((row) => row.shortcode));
    const codes = (...rows: { shortcode: string }[]) =>
      rows.map((row) => row.shortcode).sort();
    const listedCategories = async (
      filters: Parameters<typeof listProductCategories>[1],
    ) =>
      (await listProductCategories(db(), filters, [], page)).data
        .map((row) => row.id)
        .filter((id) => categoryIds.has(id))
        .sort();
    const categoryCases: Array<
      [Parameters<typeof listProductCategories>[1], string[]]
    > = [
      [{ effectiveSpendingCategoryId: [s1.shortcode] }, codes(c1, c2, c3, c7)],
      [
        {
          effectiveSpendingCategoryId: [s1.shortcode],
          includeSubSpendingCategories: false,
        },
        codes(c1, c2, c3),
      ],
      [{ effectiveSpendingCategoryId: [s1c.shortcode] }, codes(c7)],
      // `blocked` is an explicit None that stops the walk.
      [{ effectiveSpendingCategoryPresenceFilter: "none" }, codes(c4, c5, c6)],
      [{ effectiveSpendingCategoryExclude: [s1.shortcode] }, codes(c4, c5, c6)],
    ];
    for (const [filters, expected] of categoryCases)
      expect({ filters, ids: await listedCategories(filters) }).toEqual({
        filters,
        ids: expected,
      });

    const shelf = await createLocationFixture(
      db(),
      makeLocationInput({ name: "Inherit shelf", type: "shelf" }),
      ctx.actor,
    );
    const product = async (name: string, from?: { shortcode: string }) => {
      const created = await createProductFixture(
        db(),
        makeProductInput(
          from === undefined
            ? { name }
            : { name, categoryId: from.shortcode as never },
        ),
        ctx.actor,
      );
      const stock = await createInventoryFixture(
        db(),
        {
          productId: created.id as never,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
      return { shortcode: created.id, stock: stock.id };
    };
    const products = {
      c1: await product("Inherit in C1", c1),
      c2: await product("Inherit in C2", c2),
      c3: await product("Inherit in C3", c3),
      c4: await product("Inherit in C4", c4),
      c5: await product("Inherit in C5", c5),
      c6: await product("Inherit in C6", c6),
      c7: await product("Inherit in C7", c7),
      none: await product("Inherit uncategorized"),
    };
    const all = Object.values(products);
    const productIds = new Set(all.map((row) => row.shortcode));
    const stockIds = new Set(all.map((row) => row.stock));
    const listedProducts = async (filters: Parameters<typeof productList>[1]) =>
      (await productList(db(), filters, [], page)).data
        .map((row) => row.id)
        .filter((id) => productIds.has(id))
        .sort();
    const stockOf = new Map<string, string>(
      all.map((row) => [row.shortcode, row.stock]),
    );
    const listedStock = async (
      filters: Parameters<typeof inventoryentryList>[1],
    ) =>
      (await inventoryentryList(db(), filters, [], page)).data
        .map((row) => row.id)
        .filter((id) => stockIds.has(id))
        .sort();
    const p = products;
    const productCases: Array<[Parameters<typeof productList>[1], string[]]> = [
      [{ categoryFeatureFilter: ["food"] }, codes(p.c1, p.c2, p.c7)],
      [{ categoryFeatureFilter: ["tools"] }, codes(p.c4, p.c6)],
      [
        { categoryFeatureExclude: ["food"] },
        codes(p.c3, p.c4, p.c5, p.c6, p.none),
      ],
      // Behavior change (plan §14.3): No value is "no effective feature",
      // not "no category".
      [{ categoryFeaturePresenceFilter: "none" }, codes(p.c3, p.c5, p.none)],
      [
        { categoryFeaturePresenceFilter: "has" },
        codes(p.c1, p.c2, p.c4, p.c6, p.c7),
      ],
    ];
    for (const [filters, expected] of productCases) {
      expect({ filters, ids: await listedProducts(filters) }).toEqual({
        filters,
        ids: expected,
      });
      expect({
        filters,
        ids: await listedStock(filters as never),
      }).toEqual({
        filters,
        ids: expected.map((code) => stockOf.get(code)).sort(),
      });
    }
  });
});
