import { connectedViews } from "@cubby/schemas/connected-views";
import { allEntities } from "@cubby/schemas/entity-manifest";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { projectCreateInput, taskCreateInput } from "@cubby/schemas/project";
import { purchaseCreateInput } from "@cubby/schemas/purchase";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { product } from "~/server/db/schema";

import {
  compiledConnectedRoutes,
  getConnectedRecords,
} from "./connected-records";
import { getDb } from "./database-helpers";
import { createExpense } from "./expense";
import { createPlanting } from "./garden";
import { createProject } from "./project";
import { createPurchase } from "./purchase";
import { attachPurchaseProducts } from "./purchase-products";
import {
  createPlantFixture,
  createProductFixture,
  makeExpenseInput,
  makeProductInput,
} from "./repo.fixtures";
import { createTask } from "./task/crud";
import { createVendor } from "./vendor";

describe("complete connected record tables", () => {
  const ctx = withTestDb();

  it("compiles every curated and existing relation table through local traversals", () => {
    for (const source of allEntities) {
      for (const view of connectedViews[source]) {
        expect(
          compiledConnectedRoutes(source, view.key).length,
        ).toBeGreaterThan(0);
      }
      for (const section of entitySummary[source].detail.sections) {
        if (section.kind !== "relation") continue;
        expect(
          compiledConnectedRoutes(source, `relation:${section.relation}`)
            .length,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("queries sources without a soft-delete column", async () => {
    const page = await getConnectedRecords(ctx.db, {
      source: { entityType: "importRun", entityId: "RUN-EXAMPLE" },
      viewKey: "products",
    });
    expect(page.totalCount).toBe(0);
  });

  it("follows a planting task's inherited project assignment", async () => {
    const plant = await createPlantFixture(
      ctx.db,
      { name: "Inherited crop" },
      ctx.actor,
    );
    const project = await createProject(
      ctx.db,
      projectCreateInput.parse({ name: "Inherited project" }),
      ctx.actor,
    );
    const parent = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Parent work",
        trade: "other",
        projectId: project.output.id,
      }),
      ctx.actor,
    );
    const child = await createTask(
      ctx.db,
      taskCreateInput.parse({
        name: "Child work",
        trade: "other",
        parentTaskId: parent.output.id,
      }),
      ctx.actor,
    );
    await createPlanting(
      ctx.db,
      { plantId: plant.id, taskId: child.output.id, status: "planned" },
      ctx.actor,
    );

    const result = await getConnectedRecords(ctx.db, {
      source: { entityType: "plant", entityId: plant.id },
      viewKey: "projects",
    });
    expect(
      result.items.find((item) => item.target.entityId === project.output.id)
        ?.paths,
    ).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([
          expect.objectContaining({ entityType: "planting" }),
          expect.objectContaining({
            entityType: "task",
            entityId: child.output.id,
          }),
        ]),
      ]),
    );
  });

  it("pages distinct Plant purchases and preserves every actual record path", async () => {
    const plant = await createPlantFixture(
      ctx.db,
      { name: "Example crop" },
      ctx.actor,
    );
    const seed = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Example seeds", growsPlantId: plant.id }),
      ctx.actor,
    );
    const starter = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Example starter", growsPlantId: plant.id }),
      ctx.actor,
    );
    const vendor = await createVendor(
      ctx.db,
      {
        name: "Example supplier",
        website: null,
        orderUrlTemplate: null,
        orderEvidence: null,
        orderEmailSenders: [],
        browserDomains: [],
        returnWindowDays: null,
        agentHints: {
          ordersListUrl: null,
          pagination: null,
          orderLinkPattern: null,
          notes: [],
        },
        notes: null,
      },
      ctx.actor,
    );
    const purchase = async (orderId: string) =>
      createPurchase(
        ctx.db,
        purchaseCreateInput.parse({
          vendorId: vendor.output.id,
          orderId,
          displayLabel: orderId,
          date: "2026-09-08",
          statedTotal: 10,
          notes: null,
        }),
        ctx.actor,
      );
    const first = await purchase("example-order-one");
    const second = await purchase("example-order-two");
    await attachPurchaseProducts(
      ctx.db,
      first.entityId,
      [seed.entityId],
      ctx.actor,
    );
    await attachPurchaseProducts(
      ctx.db,
      second.entityId,
      [starter.entityId],
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Example seed line",
        productId: seed.id,
        purchaseId: first.output.id,
      }),
      ctx.actor,
    );
    await createExpense(
      ctx.db,
      makeExpenseInput({
        name: "Example second seed line",
        productId: seed.id,
        purchaseId: first.output.id,
      }),
      ctx.actor,
    );

    const source = { entityType: "plant" as const, entityId: plant.id };
    const page1 = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "purchases",
      limit: 1,
      offset: 0,
    });
    const page2 = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "purchases",
      limit: 1,
      offset: 1,
    });
    expect(page1.totalCount).toBe(2);
    expect(page2.totalCount).toBe(2);
    expect(
      new Set(
        [...page1.items, ...page2.items].map((item) => item.target.entityId),
      ),
    ).toEqual(new Set([first.output.id, second.output.id]));
    const firstRecord = [...page1.items, ...page2.items].find(
      (item) => item.target.entityId === first.output.id,
    );
    expect(firstRecord?.shortestHops).toBe(2);
    expect(
      firstRecord?.paths.map((path) => path.map((node) => node.entityType)),
    ).toEqual(
      expect.arrayContaining([
        ["plant", "product", "purchase"],
        ["plant", "product", "expense", "purchase"],
      ]),
    );
    expect(firstRecord?.paths.filter((path) => path.length === 4)).toHaveLength(
      2,
    );

    await getDb(ctx.db)
      .update(product)
      .set({ deletedAt: new Date() })
      .where(eq(product.id, starter.entityId));
    const afterDelete = await getConnectedRecords(ctx.db, {
      source,
      viewKey: "purchases",
    });
    expect(afterDelete.totalCount).toBe(1);
    expect(afterDelete.items[0]?.target.entityId).toBe(first.output.id);
  });
});
