import { eq } from "drizzle-orm";
import { createRepoEntity } from "tooling/factories/repo";
import { TEST_HOME_SHORTCODE, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { plant as plantTable, vendor as vendorTable } from "~/server/db/schema";
import { cookbookList } from "~/server/domains/cookbook/repo/cookbook";
import { expenseList } from "~/server/domains/expense/repo/lookup";
import { plantingList } from "~/server/domains/garden/repo/garden";
import {
  inventoryentryList,
  inventoryentryListRead,
} from "~/server/domains/inventory/repo/crud";
import { locationList } from "~/server/domains/location/repo/crud";
import { productList } from "~/server/domains/product/repo/crud";
import { projectList } from "~/server/domains/project/repo/lookup";
import { purchaseList } from "~/server/domains/purchase/repo/purchase";
import { listSpendingCategories } from "~/server/domains/spending-category/repo/spending-category";
import { taskList } from "~/server/domains/task/repo/lookup";
import { vendorList } from "~/server/domains/vendor/repo/vendor";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture,
  makeCookbookExtraction,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "~/server/testing/repo.fixtures";

const page = { pageIndex: 0, pageSize: 50 };

/**
 * Declared list fields against real rows. Failure modes: a related path that
 * ends in a hierarchy matches only the selected record, ignores its toggle,
 * or sorts by something other than the related title; a subtree filter on
 * projects or tasks stops at direct children; a sort that moved from a
 * per-entity resolver into `model.derived` (a GTIN, a `related:` view, an
 * effective reference, a multi-hop path) orders differently or surfaces
 * empties first; a field that kept its resolver's NULL placement (empties
 * first under desc) flips to last; a count read rejects a sort it never runs;
 * generated Any value / No value narrows instead of ORing beside picked
 * values; Match all matches any; Exclude drops rows with no value (a plain
 * `NOT IN`), keeps a hierarchy node's descendants, cannot combine with an
 * include, or silently ignores a predicate that cannot negate; an id filter
 * matches a soft-deleted or unknown record's code.
 */
describe("compiled list fields", () => {
  const ctx = withTestDb();

  it("filters and sorts inventory through product.category with descendants", async () => {
    const root = await createRepoEntity(ctx, "productCategory", {
      name: "Compiler outerwear",
    });
    const child = await createRepoEntity(ctx, "productCategory", {
      name: "Compiler anoraks",
      parentId: root.output.id,
    });
    const other = await createRepoEntity(ctx, "productCategory", {
      name: "Compiler blankets",
    });
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Compiler shelf",
        type: "shelf",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    const stock = async (name: string, categoryId: typeof child.output.id) => {
      const item = await createProductFixture(
        ctx.db,
        makeProductInput({ name, categoryId }),
        ctx.actor,
      );
      return createInventoryFixture(
        ctx.db,
        {
          productId: item.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    };
    const anorak = await stock("Compiler anorak", child.output.id);
    const blanket = await stock("Compiler blanket", other.output.id);
    const ids = async (filters: Parameters<typeof inventoryentryList>[1]) =>
      (await inventoryentryList(ctx.db, filters, [], page)).data.map(
        (row) => row.id,
      );

    expect(await ids({ categoryFilter: [root.output.id] })).toEqual([
      anorak.id,
    ]);
    // Several selected roots seed the recursion together.
    expect(
      (await ids({ categoryFilter: [root.output.id, other.output.id] })).sort(),
    ).toEqual([anorak.id, blanket.id].sort());
    expect(
      await ids({
        categoryFilter: [root.output.id],
        includeSubProductCategories: false,
      }),
    ).toEqual([]);

    const sorted = await inventoryentryList(
      ctx.db,
      { categoryFilter: [child.output.id, other.output.id] },
      [{ orderBy: "category", direction: "desc" }],
      page,
    );
    expect(sorted.data.map((row) => row.id)).toEqual([blanket.id, anorak.id]);

    // A count skips the valuation prepare, so it must not build the derived
    // valuation ORDER BY that reads it.
    const counted = await inventoryentryListRead(
      ctx.db,
      { categoryFilter: [root.output.id] },
      [{ orderBy: "valuation", direction: "asc" }],
      page,
      { kind: "full" },
      "count",
    );
    expect(counted.count).toBe(1);
  });

  it("ORs generated No value beside picked values on stored and related fields", async () => {
    const parent = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Presence household",
    });
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Presence utilities",
      parentId: parent.id,
    });
    const other = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Presence travel",
    });
    const named = async (
      filters: Parameters<typeof listSpendingCategories>[1],
    ) =>
      (await listSpendingCategories(ctx.db, filters, [], page)).data
        .map((row) => row.name)
        .filter((name) => name.startsWith("Presence"))
        .sort();

    expect(await named({ parentIdPresenceFilter: "none" })).toEqual([
      "Presence household",
      "Presence travel",
    ]);
    expect(await named({ parentIdPresenceFilter: "has" })).toEqual([
      "Presence utilities",
    ]);
    expect(
      await named({
        parentId: [parent.shortcode],
        parentIdPresenceFilter: "none",
      }),
    ).toEqual(["Presence household", "Presence travel", "Presence utilities"]);
    expect(await named({ parentId: [other.shortcode] })).toEqual([]);

    // Related (`via`) field: No value is a product with no category.
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Presence shelf",
        type: "shelf",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    const category = await createRepoEntity(ctx, "productCategory", {
      name: "Presence lamps",
    });
    const stock = async (
      name: string,
      categoryId?: typeof category.output.id,
    ) => {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput(categoryId ? { name, categoryId } : { name }),
        ctx.actor,
      );
      return createInventoryFixture(
        ctx.db,
        {
          productId: product.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    };
    const lamp = await stock("Presence lamp", category.output.id);
    const loose = await stock("Presence loose item");
    const ids = async (filters: Parameters<typeof inventoryentryList>[1]) =>
      (await inventoryentryList(ctx.db, filters, [], page)).data
        .map((row) => row.id)
        .filter((id) => id === lamp.id || id === loose.id)
        .sort();
    expect(await ids({ categoryPresenceFilter: "none" })).toEqual([loose.id]);
    expect(
      await ids({
        categoryFilter: [category.output.id],
        categoryPresenceFilter: "none",
      }),
    ).toEqual([lamp.id, loose.id].sort());
  });

  it("matches every picked value under Match all on a multi-valued field", async () => {
    for (const [name, subjects] of [
      ["Match baking and bread", ["baking", "bread"]],
      ["Match baking only", ["baking"]],
      ["Match no subjects", []],
    ] as const)
      await insertWithShortcode(ctx.db, "cookbook", {
        name,
        subjects: [...subjects],
        sourceLabel: name,
        rawJson: makeCookbookExtraction(),
      });
    const named = async (filters: Parameters<typeof cookbookList>[1]) =>
      (await cookbookList(ctx.db, filters, [], page)).data
        .map((row) => row.name)
        .filter((name) => name.startsWith("Match"))
        .sort();

    expect(await named({ subjectFilters: ["baking", "bread"] })).toEqual([
      "Match baking and bread",
      "Match baking only",
    ]);
    expect(
      await named({
        subjectFilters: ["baking", "bread"],
        subjectsMatch: "all",
      }),
    ).toEqual(["Match baking and bread"]);
    expect(
      await named({
        subjectFilters: ["baking", "bread"],
        subjectsMatch: "all",
        subjectsPresenceFilter: "none",
      }),
    ).toEqual(["Match baking and bread", "Match no subjects"]);
  });

  it("excludes values and their descendants, keeping rows with no value", async () => {
    // Stored self-reference: excluding a parent drops its subtree only.
    const household = await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Exclude household",
    });
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Exclude utilities",
      parentId: household.id,
    });
    const named = async (
      filters: Parameters<typeof listSpendingCategories>[1],
    ) =>
      (await listSpendingCategories(ctx.db, filters, [], page)).data
        .map((row) => row.name)
        .filter((name) => name.startsWith("Exclude"))
        .sort();
    expect(await named({ parentIdExclude: [household.shortcode] })).toEqual([
      "Exclude household",
    ]);

    // Related path ending in a hierarchy: inventory → product.category.
    const clothing = await createRepoEntity(ctx, "productCategory", {
      name: "Exclude clothing",
    });
    const outerwear = await createRepoEntity(ctx, "productCategory", {
      name: "Exclude outerwear",
      parentId: clothing.output.id,
    });
    const anoraks = await createRepoEntity(ctx, "productCategory", {
      name: "Exclude anoraks",
      parentId: outerwear.output.id,
    });
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({
        name: "Exclude shelf",
        type: "shelf",
        parentId: TEST_HOME_SHORTCODE,
      }),
      ctx.actor,
    );
    const stock = async (
      name: string,
      categoryId?: typeof clothing.output.id,
    ) => {
      const product = await createProductFixture(
        ctx.db,
        makeProductInput(categoryId ? { name, categoryId } : { name }),
        ctx.actor,
      );
      return createInventoryFixture(
        ctx.db,
        {
          productId: product.id,
          locationId: shelf.id,
          amount: { value: 1, unit: "each" },
        },
        ctx.actor,
      );
    };
    const sweater = await stock("Exclude sweater", clothing.output.id);
    const parka = await stock("Exclude parka", outerwear.output.id);
    const anorak = await stock("Exclude anorak", anoraks.output.id);
    const loose = await stock("Exclude loose item");
    const ours = new Set([sweater.id, parka.id, anorak.id, loose.id]);
    const ids = async (filters: Parameters<typeof inventoryentryList>[1]) =>
      (await inventoryentryList(ctx.db, filters, [], page)).data
        .map((row) => row.id)
        .filter((id) => ours.has(id))
        .sort();

    // The uncategorized item is not Outerwear, and neither is a sweater; an
    // anorak is, through its parent.
    expect(await ids({ categoryExclude: [outerwear.output.id] })).toEqual(
      [sweater.id, loose.id].sort(),
    );
    expect(
      await ids({
        categoryExclude: [outerwear.output.id],
        includeSubProductCategories: false,
      }),
    ).toEqual([sweater.id, anorak.id, loose.id].sort());
    // Clothing except Outerwear.
    expect(
      await ids({
        categoryFilter: [clothing.output.id],
        categoryExclude: [outerwear.output.id],
      }),
    ).toEqual([sweater.id]);
    // The presence filter drops the empty row.
    expect(
      await ids({
        categoryExclude: [outerwear.output.id],
        categoryPresenceFilter: "has",
      }),
    ).toEqual([sweater.id]);

    // Stored text array: none of the excluded subjects.
    for (const [name, subjects] of [
      ["Exclude baking and bread", ["baking", "bread"]],
      ["Exclude baking only", ["baking"]],
      ["Exclude no subjects", []],
    ] as const)
      await insertWithShortcode(ctx.db, "cookbook", {
        name,
        subjects: [...subjects],
        sourceLabel: name,
        rawJson: makeCookbookExtraction(),
      });
    expect(
      (
        await cookbookList(ctx.db, { subjectsExclude: ["bread"] }, [], page)
      ).data
        .map((row) => row.name)
        .filter((name) => name.startsWith("Exclude"))
        .sort(),
    ).toEqual(["Exclude baking only", "Exclude no subjects"]);
  });

  it("negates a negatable predicate and rejects one that is not", async () => {
    const renovation = (
      await createRepoEntity(ctx, "project", { name: "Exclude renovation" })
    ).output;
    const kitchen = (
      await createRepoEntity(ctx, "project", {
        name: "Exclude kitchen",
        parentProjectId: renovation.id,
      })
    ).output;
    const task = async (name: string, projectId?: typeof kitchen.id) =>
      (
        await createRepoEntity(ctx, "task", {
          name,
          trade: "other",
          ...(projectId ? { projectId } : {}),
        })
      ).output.id;
    const inKitchen = await task("Exclude kitchen task", kitchen.id);
    const loose = await task("Exclude loose task");
    const ours = new Set([inKitchen, loose]);
    // The inherited-project predicate is negatable: a sub-project's task is
    // excluded with its parent, a task with no project stays.
    expect(
      (
        await taskList(ctx.db, { projectIdExclude: [renovation.id] }, [], page)
      ).data
        .map((row) => row.id)
        .filter((id) => ours.has(id)),
    ).toEqual([loose]);

    // Expense allocation filters read data prepared from the include values,
    // so negating them would silently ignore the excluded ones.
    await expect(
      expenseList(ctx.db, { projectIdExclude: [renovation.id] }, [], page),
    ).rejects.toThrow(
      /Cannot exclude expense by "projectId": Include only: Matches the expense's allocation shares/,
    );
  });

  it("includes every level below a selected project", async () => {
    const parent = await createRepoEntity(ctx, "project", {
      name: "Compiler renovation",
    });
    const child = await createRepoEntity(ctx, "project", {
      name: "Compiler kitchen",
      parentProjectId: parent.output.id,
    });
    const grandchild = await createRepoEntity(ctx, "project", {
      name: "Compiler cabinets",
      parentProjectId: child.output.id,
    });
    const projects = await projectList(
      ctx.db,
      { parentProjectId: parent.output.id, includeSubProjects: true },
      [{ orderBy: "name", direction: "asc" }],
      page,
    );
    expect(projects.data.map((row) => row.id)).toEqual([
      grandchild.output.id,
      child.output.id,
    ]);

    const tasks = await Promise.all(
      [parent, child, grandchild].map((project) =>
        createRepoEntity(ctx, "task", {
          name: `Compiler task ${project.output.name}`,
          trade: "other",
          projectId: project.output.id,
        }),
      ),
    );
    const subtree = await taskList(
      ctx.db,
      { projectId: child.output.id, includeSubProjects: true },
      [{ orderBy: "name", direction: "asc" }],
      page,
    );
    expect(subtree.data.map((row) => row.id)).toEqual([
      tasks[2]!.output.id,
      tasks[1]!.output.id,
    ]);
  });

  it("orders products by a derived GTIN and a related view, empties last", async () => {
    const product = (name: string, upc?: string) =>
      createProductFixture(ctx.db, makeProductInput({ name, upc }), ctx.actor);
    const late = await product("Compiler late barcode", "036000291452");
    const early = await product("Compiler early barcode", "012345678905");
    const bare = await product("Compiler no barcode");
    const vendor = (name: string) =>
      createRepoEntity(ctx, "vendor", { name }).then(({ output }) => output);
    const purchase = async (vendorName: string, orderId: string) =>
      (
        await createRepoEntity(ctx, "purchase", {
          date: "2026-03-02",
          vendorId: (await vendor(vendorName)).id,
          orderId,
        })
      ).output;
    const buy = async (
      productId: string,
      vendorName: string,
      orderId: string,
    ) =>
      createRepoEntity(ctx, "expense", {
        name: `Compiler line ${orderId}`,
        date: "2026-03-02",
        trade: "other",
        costType: "materials",
        cost: 10,
        future: false,
        productId,
        purchaseId: (await purchase(vendorName, orderId)).id,
      });
    await buy(late.id, "Compiler Alder Supply", "compiler-order-b");
    await buy(early.id, "Compiler Zinnia Goods", "compiler-order-a");
    const ids = [late.id, early.id, bare.id];
    const order = async (orderBy: string, direction: "asc" | "desc") =>
      (
        await productList(ctx.db, { ids }, [{ orderBy, direction }], page)
      ).data.map((row) => row.id);
    expect(await order("primaryGtin", "asc")).toEqual([
      early.id,
      late.id,
      bare.id,
    ]);
    expect(await order("primaryGtin", "desc")).toEqual([
      late.id,
      early.id,
      bare.id,
    ]);
    expect(await order("related:product.vendors", "asc")).toEqual([
      late.id,
      early.id,
      bare.id,
    ]);
    expect(await order("related:product.vendors", "desc")).toEqual([
      early.id,
      late.id,
      bare.id,
    ]);

    // Expense → Purchase → Vendor and → Purchase.orderId, from declared paths.
    const expenses = async (orderBy: string) =>
      (
        await expenseList(ctx.db, {}, [{ orderBy, direction: "asc" }], page)
      ).data.map((row) => row.name);
    expect(await expenses("purchaseId")).toEqual([
      "Compiler line compiler-order-b",
      "Compiler line compiler-order-a",
    ]);
    expect(await expenses("orderId")).toEqual([
      "Compiler line compiler-order-a",
      "Compiler line compiler-order-b",
    ]);
  });

  it("orders products by quantity variance, incomparable last", async () => {
    const shelf = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Compiler variance shelf" }),
      ctx.actor,
    );
    // Bought `bought` units, counted `counted` on the shelf.
    const stocked = async (name: string, bought: number, counted: number) => {
      const created = await createProductFixture(
        ctx.db,
        makeProductInput({ name }),
        ctx.actor,
      );
      await createRepoEntity(
        ctx,
        "expense",
        makeExpenseInput({
          name: `${name} purchase`,
          cost: 10,
          productId: created.id,
          productQuantity: bought,
        }),
      );
      await createInventoryFixture(
        ctx.db,
        {
          productId: created.entityId,
          locationId: shelf.entityId,
          amount: { value: counted, unit: "each" },
        },
        ctx.actor,
      );
      return created.id;
    };
    const short = await stocked("Compiler variance short", 3, 1);
    const matched = await stocked("Compiler variance matched", 2, 2);
    const surplus = await stocked("Compiler variance surplus", 1, 3);
    const uncounted = (
      await createProductFixture(
        ctx.db,
        makeProductInput({ name: "Compiler variance uncounted" }),
        ctx.actor,
      )
    ).id;
    const ids = [matched, uncounted, surplus, short];
    const order = async (direction: "asc" | "desc") =>
      (
        await productList(
          ctx.db,
          { ids },
          [{ orderBy: "quantityVariance", direction }],
          page,
        )
      ).data.map((row) => row.id);
    expect(await order("asc")).toEqual([short, matched, surplus, uncounted]);
    expect(await order("desc")).toEqual([surplus, matched, short, uncounted]);
  });

  it("orders tasks by an inherited project through the declared path", async () => {
    const project = (name: string) =>
      createRepoEntity(ctx, "project", { name }).then(({ output }) => output);
    const alpha = await project("Compiler alpha project");
    const omega = await project("Compiler omega project");
    const parent = (
      await createRepoEntity(ctx, "task", {
        name: "Compiler omega parent",
        trade: "other",
        projectId: omega.id,
      })
    ).output;
    // Inherits omega from its parent; no project of its own.
    const child = (
      await createRepoEntity(ctx, "task", {
        name: "Compiler inherited child",
        trade: "other",
        parentTaskId: parent.id,
      })
    ).output;
    const own = (
      await createRepoEntity(ctx, "task", {
        name: "Compiler alpha task",
        trade: "other",
        projectId: alpha.id,
      })
    ).output;
    const sorted = await taskList(
      ctx.db,
      {},
      [
        { orderBy: "projectId", direction: "asc" },
        { orderBy: "name", direction: "asc" },
      ],
      page,
    );
    expect(sorted.data.map((row) => row.id)).toEqual([
      own.id,
      child.id,
      parent.id,
    ]);
  });
  it("keeps a declared field's empties first when descending", async () => {
    const vendor = (name: string) =>
      createRepoEntity(ctx, "vendor", { name }).then(({ output }) => output);
    const bought = await vendor("Compiler bought vendor");
    const idle = await vendor("Compiler idle vendor");
    const named = (
      await createRepoEntity(ctx, "purchase", {
        date: "2026-03-02",
        vendorId: bought.id,
      })
    ).output;
    // A Purchase reads its live Vendor's name; a retired Vendor reads none.
    const retired = await vendor("Compiler retired vendor");
    const vendorless = (
      await createRepoEntity(ctx, "purchase", {
        date: "2026-03-03",
        vendorId: retired.id,
      })
    ).output;
    await getDb(ctx.db)
      .update(vendorTable)
      .set({ deletedAt: new Date() })
      .where(eq(vendorTable.name, retired.name));
    const vendors = async (direction: "asc" | "desc") =>
      (
        await vendorList(
          ctx.db,
          {},
          [{ orderBy: "latestPurchaseDate", direction }],
          page,
        )
      ).data.map((row) => row.id);
    expect(await vendors("desc")).toEqual([idle.id, bought.id]);
    expect(await vendors("asc")).toEqual([bought.id, idle.id]);
    const purchases = async (direction: "asc" | "desc") =>
      (
        await purchaseList(
          ctx.db,
          {},
          [{ orderBy: "vendorId", direction }],
          page,
        )
      ).data.map((row) => row.id);
    expect(await purchases("desc")).toEqual([vendorless.id, named.id]);
    expect(await purchases("asc")).toEqual([named.id, vendorless.id]);
  });

  it("matches nothing for an id filter naming a soft-deleted or unknown record", async () => {
    const basil = await insertWithShortcode(ctx.db, "plant", {
      name: "Compiler basil",
    });
    const seeds = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Compiler basil seeds",
        growsPlantId: basil.shortcode,
      }),
      ctx.actor,
    );
    const bed = await insertWithShortcode(ctx.db, "planting", {
      plantId: basil.id,
      status: "planned",
    });
    // Product reads the plant through a related path; planting's stored
    // reference compiles to the live-row shortcode subquery.
    const matches = async (code: string) => ({
      products: (
        await productList(ctx.db, { growsPlantIdFilter: code }, [], page)
      ).data.map((row) => row.id),
      plantings: (await plantingList(ctx.db, { plantId: code }, page)).data.map(
        (row) => row.id,
      ),
    });
    expect(await matches(basil.shortcode)).toEqual({
      products: [seeds.id],
      plantings: [bed.shortcode],
    });
    // Both rows still reference the retired plant's id.
    await getDb(ctx.db)
      .update(plantTable)
      .set({ deletedAt: new Date() })
      .where(eq(plantTable.id, basil.id));
    const none = { products: [], plantings: [] };
    expect(await matches(basil.shortcode)).toEqual(none);
    const prefix = basil.shortcode.split("-")[0];
    expect(await matches(`${prefix}-ZZZZ`)).toEqual(none);
  });

  it("counts locations under a valuation sort", async () => {
    await createLocationFixture(ctx.db, makeLocationInput(), ctx.actor);
    const counted = await locationList(
      ctx.db,
      {},
      [{ orderBy: "valuation", direction: "desc" }],
      page,
      "count",
    );
    expect(counted.count).toBeGreaterThan(0);
  });
});
