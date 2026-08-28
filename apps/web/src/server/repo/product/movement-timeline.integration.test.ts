import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ProductFilters } from "@cubby/schemas/product";
import { expenseCreateInput, projectCreateInput } from "@cubby/schemas/project";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { createExpense } from "../expense";
import { createProject, setProjectToolUsage } from "../project";
import { attachPurchaseProducts } from "../purchase-products";
import {
  createInventoryFixture,
  createLocationFixture,
  createProductFixture as createProduct,
  makeExpenseInput,
  makeLocationInput,
  makeProductInput,
} from "../repo.fixtures";
import { insertWithShortcode } from "../shortcode-utils";
import { findOrCreateVendor } from "../vendor";
import { productList } from "./crud";
import { getProductMovementTimeline } from "./movement-timeline";

describe("getProductMovementTimeline", () => {
  const ctx = withTestDb();

  it("applies Product filters before returning Purchase-grouped movements", async () => {
    const included = await createProduct(
      ctx.db,
      makeProductInput({ name: "Acme Drill", manufacturer: "Acme" }),
      ctx.actor,
    );
    const excluded = await createProduct(
      ctx.db,
      makeProductInput({ name: "Other Drill", manufacturer: "Other" }),
      ctx.actor,
    );
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "Acme Drill Without Movement",
        manufacturer: "Acme",
      }),
      ctx.actor,
    );

    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Acme drill kit",
          cost: 40,
          date: "2024-01-20",
          productId: included.id,
          productQuantity: 2,
          vendor: "Tool Shop",
          orderId: "ORDER-1",
        }),
      ),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Other drill kit",
          cost: 80,
          date: "2024-02-20",
          productId: excluded.id,
          productQuantity: 1,
          vendor: "Tool Shop",
          orderId: "ORDER-2",
        }),
      ),
      ctx.actor,
    );

    const result = await getProductMovementTimeline(ctx.db, {
      filters: { manufacturerExact: "Acme" },
      order: "desc",
    });

    expect(result.products.map((product) => product.id)).toEqual([included.id]);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]).toMatchObject({
      date: "2024-01-20",
      purchase: { orderId: "ORDER-1", vendor: { name: "Tool Shop" } },
      movements: [
        {
          productId: included.id,
          kind: "acquired",
          cost: 40,
          quantity: 2,
          signedQuantity: 2,
          provenanceOnly: false,
        },
      ],
    });
    expect(result.summary).toMatchObject({
      matchingProducts: 2,
      productsWithMovements: 1,
      movementCount: 1,
      spent: 40,
      recovered: 0,
      netCost: 40,
      unknownAmountCount: 0,
    });
    expect(result.omitted.productsWithoutMovements).toBe(1);
  });

  it("shows unitemized Purchase provenance once and yields to an itemized Expense", async () => {
    const item = await createProduct(
      ctx.db,
      makeProductInput({ name: "Unitemized Range" }),
      ctx.actor,
    );
    const vendorId = await findOrCreateVendor(ctx.db, "Appliance Store");
    const order = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2025-03-04",
      orderId: "APPLIANCE-1",
      displayLabel: "Kitchen package",
    });
    await attachPurchaseProducts(ctx.db, order.id, [item.entityId], ctx.actor);

    const provenance = await getProductMovementTimeline(ctx.db, {
      filters: { nameFilter: "Unitemized Range" },
      order: "desc",
    });
    expect(provenance.groups[0]?.movements).toEqual([
      expect.objectContaining({
        productId: item.id,
        kind: "acquired",
        cost: null,
        quantity: null,
        provenanceOnly: true,
      }),
    ]);
    expect(provenance.summary.unknownAmountCount).toBe(1);

    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Planned range line",
          cost: 800,
          date: "2025-03-06",
          productId: item.id,
          productQuantity: 1,
          purchaseId: parseShortcodeFor("purchase", order.shortcode),
          future: true,
        }),
      ),
      ctx.actor,
    );
    const plannedDoesNotHideProvenance = await getProductMovementTimeline(
      ctx.db,
      {
        filters: { nameFilter: "Unitemized Range" },
        order: "desc",
      },
    );
    expect(plannedDoesNotHideProvenance.groups[0]?.movements).toEqual([
      expect.objectContaining({ provenanceOnly: true }),
    ]);
    expect(plannedDoesNotHideProvenance.omitted.plannedMovements).toBe(1);

    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Range item line",
          cost: 900,
          date: "2025-03-08",
          productId: item.id,
          productQuantity: 1,
          purchaseId: parseShortcodeFor("purchase", order.shortcode),
        }),
      ),
      ctx.actor,
    );

    const itemized = await getProductMovementTimeline(ctx.db, {
      filters: { nameFilter: "Unitemized Range" },
      order: "desc",
    });
    expect(itemized.groups).toHaveLength(1);
    expect(itemized.groups[0]?.movements).toHaveLength(1);
    expect(itemized.groups[0]?.movements[0]).toMatchObject({
      name: "Range item line",
      cost: 900,
      provenanceOnly: false,
    });
  });

  it("keeps charged-to and used-on Projects distinct and omits planned movements", async () => {
    const tool = await createProduct(
      ctx.db,
      makeProductInput({ name: "Project Timeline Tool", category: "tools" }),
      ctx.actor,
    );
    const { output: chargedProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Charged Project" }),
      ctx.actor,
    );
    const { output: usedProject, entityId: usedProjectId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "Used Project" }),
        ctx.actor,
      );
    await setProjectToolUsage(
      ctx.db,
      usedProjectId,
      tool.entityId,
      true,
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Bought for project",
          cost: 50,
          productId: tool.id,
          productQuantity: 1,
          projectId: chargedProject.id,
        }),
      ),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Replacement planned",
          cost: 60,
          productId: tool.id,
          productQuantity: 1,
          future: true,
        }),
      ),
      ctx.actor,
    );

    const result = await getProductMovementTimeline(ctx.db, {
      filters: { nameFilter: "Project Timeline Tool" },
      order: "desc",
    });

    expect(result.groups[0]?.movements[0]?.chargedTo).toEqual({
      id: chargedProject.id,
      name: "Charged Project",
    });
    expect(result.products[0]?.usedOnProjects).toEqual([
      { id: usedProject.id, name: "Used Project" },
    ]);
    expect(result.omitted.plannedMovements).toBe(1);
    expect(result.summary.movementCount).toBe(1);
  });

  it("keeps timeline and product.list cohorts identical across Product filter families", async () => {
    const included = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Cohort Timeline Tool",
        manufacturer: "Cohort Maker",
        category: "tools",
        tags: ["cohort-tag"],
      }),
      ctx.actor,
    );
    await createProduct(
      ctx.db,
      makeProductInput({
        name: "Cohort Decoy",
        manufacturer: "Other Maker",
        category: "household",
        tags: ["other-tag"],
      }),
      ctx.actor,
    );
    const { output: chargedProject } = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Cohort Charged Project" }),
      ctx.actor,
    );
    const { output: usedProject, entityId: usedProjectId } =
      await createProject(
        ctx.db,
        projectCreateInput.parse({ name: "Cohort Used Project" }),
        ctx.actor,
      );
    await setProjectToolUsage(
      ctx.db,
      usedProjectId,
      included.entityId,
      true,
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Cohort purchase",
          date: "2024-04-05",
          cost: 25,
          productId: included.id,
          productQuantity: 1,
          projectId: chargedProject.id,
          vendor: "Cohort Vendor",
          orderId: "COHORT-ORDER",
        }),
      ),
      ctx.actor,
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Cohort Shelf" }),
      ctx.actor,
    );
    await createInventoryFixture(
      ctx.db,
      {
        productId: included.id,
        locationId: location.id,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    const baseline = await getProductMovementTimeline(ctx.db, {
      filters: { nameFilter: "Cohort Timeline Tool" },
      order: "desc",
    });
    const vendorId = baseline.groups[0]?.purchase?.vendor?.id;
    expect(vendorId).toBeDefined();

    const filters: ProductFilters[] = [
      { manufacturerExact: "Cohort Maker" },
      { tagFilters: ["cohort-tag"] },
      { categoryFilter: "tools" },
      { vendorId: vendorId! },
      { projectId: chargedProject.id },
      { usedOnProjectId: usedProject.id },
      { locationIdFilter: location.id },
      { purchaseDateFrom: "2024-04-01", purchaseDateTo: "2024-04-30" },
    ];

    for (const filter of filters) {
      const [list, timeline] = await Promise.all([
        productList(ctx.db, filter, [{ orderBy: "name", direction: "asc" }], {
          pageIndex: 0,
          pageSize: 100,
        }),
        getProductMovementTimeline(ctx.db, { filters: filter, order: "desc" }),
      ]);
      expect(timeline.products.map((product) => product.id)).toEqual(
        list.data.map((product) => product.id),
      );
      expect(timeline.products.map((product) => product.id)).toEqual([
        included.id,
      ]);
    }
  });

  it("uses Purchase dates first, falls back to ledger dates, windows events, and orders groups", async () => {
    const item = await createProduct(
      ctx.db,
      makeProductInput({ name: "Movement Date Product" }),
      ctx.actor,
    );
    const vendorId = await findOrCreateVendor(ctx.db, "Timeline Vendor");
    const purchaseRow = await insertWithShortcode(ctx.db, "purchase", {
      vendorId,
      date: "2023-05-01",
      orderId: "DATE-FIRST",
    });
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Purchased earlier than ledgered",
          cost: 10,
          date: "2023-06-01",
          productId: item.id,
          productQuantity: 1,
          purchaseId: parseShortcodeFor("purchase", purchaseRow.shortcode),
        }),
      ),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Recovered later",
          cost: -4,
          date: "2024-01-01",
          productId: item.id,
          productQuantity: -1,
        }),
      ),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Discard outside window",
          cost: 0,
          date: "2024-02-01",
          productId: item.id,
          productQuantity: -1,
        }),
      ),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      expenseCreateInput.parse(
        makeExpenseInput({
          name: "Unknown outside window",
          cost: null,
          date: "2024-03-01",
          productId: item.id,
          productQuantity: null,
        }),
      ),
      ctx.actor,
    );

    const windowed = await getProductMovementTimeline(ctx.db, {
      filters: { nameFilter: "Movement Date Product" },
      movementFrom: "2023-05-01",
      movementTo: "2024-01-01",
      order: "asc",
    });
    expect(windowed.groups.map((group) => group.date)).toEqual([
      "2023-05-01",
      "2024-01-01",
    ]);
    expect(windowed.groups[0]).toMatchObject({
      purchase: { orderId: "DATE-FIRST" },
      movements: [{ expenseDate: "2023-06-01", kind: "acquired" }],
    });
    expect(windowed.groups[1]?.movements[0]).toMatchObject({
      kind: "exited",
      cost: -4,
    });
    expect(windowed.summary).toMatchObject({
      movementCount: 2,
      spent: 10,
      recovered: 4,
      netCost: 6,
    });
    expect(windowed.extent).toEqual({
      from: "2023-05-01",
      to: "2024-01-01",
    });

    const full = await getProductMovementTimeline(ctx.db, {
      filters: { nameFilter: "Movement Date Product" },
      order: "desc",
    });
    expect(full.groups.map((group) => group.movements[0]?.kind)).toEqual([
      "unknown",
      "discarded",
      "exited",
      "acquired",
    ]);

    const emptyWindow = await getProductMovementTimeline(ctx.db, {
      filters: { nameFilter: "Movement Date Product" },
      movementFrom: "2025-01-01",
      order: "desc",
    });
    expect(emptyWindow.groups).toEqual([]);
    expect(emptyWindow.products).toEqual([]);
    expect(emptyWindow.summary.productsWithMovements).toBe(0);
    expect(emptyWindow.omitted.productsWithoutMovements).toBe(1);
  });
});
