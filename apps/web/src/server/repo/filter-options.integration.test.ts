import { expenseCreateInput, projectCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { TEST_ACTOR, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createExpense } from "./expense";
import { getFilterOptions } from "./filter-options";
import { createIngredient } from "./ingredient";
import { createLedgerParty } from "./ledger-party";
import { createProduct } from "./product";
import { createProject } from "./project";
import { createPurchase } from "./purchase";
import { createRecipe } from "./recipe";
import { makeProductInput, makeRecipeInput } from "./repo.fixtures";
import { findOrCreateVendor, getVendorByID } from "./vendor";

describe("entity reference filter options", () => {
  const ctx = withTestDb();

  it("searches live shortcode entities and hydrates selected values outside the page query", async () => {
    const crop = await createIngredient(
      ctx.db,
      { name: "Selected winter squash" },
      TEST_ACTOR,
    );
    await createIngredient(
      ctx.db,
      { name: "Unrelated summer herb" },
      TEST_ACTOR,
    );

    const searched = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "ingredient",
      search: "winter squash",
      selectedIds: [],
      limit: 25,
      include: [],
    });
    expect(searched.items).toEqual([
      { id: crop.id, label: "Selected winter squash" },
    ]);

    const hydrated = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "ingredient",
      search: "no page match",
      selectedIds: [crop.id],
      limit: 25,
      include: [],
    });
    expect(hydrated.items).toEqual([
      { id: crop.id, label: "Selected winter squash" },
    ]);
  });

  // The vendor picker ranks its roster by live purchase count and shows each
  // vendor's logo; both used to come from a dedicated `vendor.options` read.
  it("projects counts and logos, ordering a counted roster by usage", async () => {
    const vendorCode = async (name: string) =>
      (await getVendorByID(ctx.db, await findOrCreateVendor(ctx.db, name))).id;
    const quiet = await vendorCode("Aardvark hardware");
    const busy = await vendorCode("Zephyr lumber");
    for (const orderId of ["ORDER-A", "ORDER-B"])
      await createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          vendorId: busy,
          date: "2026-08-01",
          orderId,
        }),
        TEST_ACTOR,
      );

    const roster = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "vendor",
      search: "",
      selectedIds: [],
      limit: 1000,
      include: ["count", "logo"],
    });
    expect(
      roster.items.map(({ id, count, logo }) => ({ id, count, logo })),
    ).toEqual([
      { id: busy, count: 2, logo: null },
      { id: quiet, count: 0, logo: null },
    ]);

    await expect(
      getFilterOptions(ctx.db, {
        source: "entity",
        entity: "ingredient",
        search: "",
        selectedIds: [],
        limit: 25,
        include: ["count"],
      }),
    ).rejects.toThrow("Filter option counts are not defined for ingredient");
  });

  // The accounts table's Owner editor used to come from a dedicated
  // `ledgerParty.options` read that always carried `kind`.
  it("projects a ledger party's kind, refusing it for an entity with no such column", async () => {
    const member = await createLedgerParty(
      ctx.db,
      { name: "Household member", kind: "member", notes: null },
      TEST_ACTOR,
    );

    const roster = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "ledgerParty",
      search: "",
      selectedIds: [],
      limit: 1000,
      include: ["kind"],
    });
    expect(roster.items).toEqual([
      { id: member.output.id, label: "Household member", kind: "member" },
    ]);

    await expect(
      getFilterOptions(ctx.db, {
        source: "entity",
        entity: "project",
        search: "",
        selectedIds: [],
        limit: 25,
        include: ["kind"],
      }),
    ).rejects.toThrow("Filter option kind is not defined for project");
  });

  it("projects a project's icon, refusing it for an entity with no such column", async () => {
    const hammer = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Deck rebuild", icon: "hammer" }),
      TEST_ACTOR,
    );

    const roster = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "project",
      search: "",
      selectedIds: [],
      limit: 25,
      include: ["icon"],
    });
    expect(roster.items).toEqual([
      { id: hammer.output.id, label: "Deck rebuild", icon: "hammer" },
    ]);

    await expect(
      getFilterOptions(ctx.db, {
        source: "entity",
        entity: "ledgerParty",
        search: "",
        selectedIds: [],
        limit: 25,
        include: ["icon"],
      }),
    ).rejects.toThrow("Filter option icon is not defined for ledgerParty");
  });

  // The `dates` projection must reuse `projectNameOptions` (and, through it,
  // `projectContentDates`/`aggregateSubtreeDates`): a project's effective
  // window is folded from its own dates plus its tasks' and expenses'.
  it("projects a project's effective content window, excluding one expense's own allocation", async () => {
    const tracked = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Kitchen refresh" }),
      TEST_ACTOR,
    );
    const charge = await createExpense(
      ctx.db,
      expenseCreateInput.parse({
        name: "Cabinet hardware",
        projectId: tracked.output.id,
        date: "2026-03-10",
        trade: "cabinetry",
        costType: "materials",
        cost: 42,
      }),
      TEST_ACTOR,
    );

    const withCharge = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "project",
      search: "",
      selectedIds: [],
      limit: 25,
      include: ["dates"],
    });
    expect(
      withCharge.items.find((item) => item.id === tracked.output.id)?.dates,
    ).toEqual({ effectiveStart: "2026-03-10", effectiveEnd: "2026-03-10" });

    const excluded = await getFilterOptions(ctx.db, {
      source: "entity",
      entity: "project",
      search: "",
      selectedIds: [],
      limit: 25,
      include: ["dates"],
      excludeExpenseId: charge.output.id,
    });
    expect(
      excluded.items.find((item) => item.id === tracked.output.id)?.dates,
    ).toEqual({ effectiveStart: null, effectiveEnd: null });

    await expect(
      getFilterOptions(ctx.db, {
        source: "entity",
        entity: "ledgerParty",
        search: "",
        selectedIds: [],
        limit: 25,
        include: ["dates"],
      }),
    ).rejects.toThrow("Filter option dates are not defined for ledgerParty");
  });
});

describe("tag filter options", () => {
  const ctx = withTestDb();

  // The recipe list's Tags filter used to come from `recipe.getAllTags`.
  it("lists the distinct recipe tag vocabulary with no usage count", async () => {
    await createRecipe(
      ctx.db,
      makeRecipeInput({
        name: "Weeknight pasta",
        tags: ["quick", "weeknight"],
      }),
      TEST_ACTOR,
    );
    await createRecipe(
      ctx.db,
      makeRecipeInput({ name: "Quick tacos", tags: ["quick"] }),
      TEST_ACTOR,
    );

    const roster = await getFilterOptions(ctx.db, {
      source: "tags",
      entity: "recipe",
      search: "",
      selectedIds: [],
      limit: 1000,
    });
    expect(roster.items).toEqual([
      { id: "quick", label: "quick" },
      { id: "weeknight", label: "weeknight" },
    ]);
  });

  // The product list's Tags filter used to come from `product.tagOptions`,
  // which — unlike recipe tags — carries a usage count.
  it("lists the product tag vocabulary with usage counts, ranked by usage", async () => {
    await createProduct(
      ctx.db,
      makeProductInput({ name: "Widget A", tags: ["m18"] }),
      TEST_ACTOR,
    );
    await createProduct(
      ctx.db,
      makeProductInput({ name: "Widget B", tags: ["m18"] }),
      TEST_ACTOR,
    );
    await createProduct(
      ctx.db,
      makeProductInput({ name: "Widget C", tags: ["m12"] }),
      TEST_ACTOR,
    );

    const roster = await getFilterOptions(ctx.db, {
      source: "tags",
      entity: "product",
      search: "",
      selectedIds: [],
      limit: 1000,
    });
    expect(roster.items).toEqual([
      { id: "m18", label: "m18", count: 2 },
      { id: "m12", label: "m12", count: 1 },
    ]);
  });
});
