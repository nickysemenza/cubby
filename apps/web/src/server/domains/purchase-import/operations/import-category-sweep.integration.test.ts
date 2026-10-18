import type { ExtractedOrderCandidate } from "@cubby/schemas/purchase-import";
import { suggestionSweepRunInput } from "@cubby/schemas/run-fields";
import { and, eq } from "drizzle-orm";
import { driveAiWork, TEST_AI_WORK_LAUNCHER } from "tooling/ai-work";
import { taxonomyId } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { activateAiRefresh } from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import { product, productCategory, run, runFinding } from "~/server/db/schema";
import {
  categoryPorts,
  kernelCtx,
  PRIMARY_MODEL,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { createSystemUserFixture } from "~/server/testing/repo.fixtures";

import { sweepImportedProductCategories } from "../service/import-category-sweep";
import { commitPurchaseImport } from "./import-orders";
import {
  memberImportWorld,
  prepareMemberImport,
} from "./order-import.fixtures";

// Failures: a commit that creates Products leaves them uncategorized, so a
// food order keeps asking to be received; the follow-up sweep blocks or fails
// the commit, targets Products the commit did not create, or applies a
// not-tracked category without settling the open arrival prompt.
describe("post-commit category suggestions", () => {
  const ctx = withTestDb();

  const candidate: ExtractedOrderCandidate = {
    orderId: "SYNTHETIC-SWEEP-1",
    orderedAt: "2026-10-01T12:00:00Z",
    merchant: "Synthetic sweep market",
    currency: "USD",
    printedGrandTotal: 9,
    lines: [
      {
        title: "Synthetic oat crackers",
        amount: 4,
        quantity: 1,
        lineKind: "principal",
      },
      {
        title: "Synthetic plum jam",
        amount: 5,
        quantity: 1,
        lineKind: "principal",
      },
    ],
    payments: [],
    allShipmentsDelivered: true,
  };

  it("sweeps exactly the created Products and settles the arrival prompt once they are untracked", async () => {
    await createSystemUserFixture(ctx.db);
    await activateAiRefresh(ctx.db, "synthetic-release", {
      enabled: true,
      startDiscovery: false,
    });
    await getDb(ctx.db)
      .update(productCategory)
      .set({ stockTracked: false })
      .where(eq(productCategory.id, taxonomyId("food")));
    const { vendor } = await memberImportWorld(ctx.db, ctx.actor, {
      vendor: { name: "Synthetic sweep market" },
    });
    const preparation = await prepareMemberImport(ctx.db, ctx.actor, {
      key: "category-sweep",
      defaultTrade: "other",
      orders: [
        {
          stableOrderId: "category-sweep",
          vendorId: vendor.shortcode,
          source: {
            kind: "receipt_photo",
            externalKey: "synthetic:category-sweep",
            checksum: "b".repeat(64),
          },
          extraction: { status: "ready", candidate },
          resolutions: [{ kind: "new" }, { kind: "new" }],
        },
      ],
    });
    const context = kernelCtx(ctx);
    const sweepPorts = {
      ...categoryPorts(),
      decisionModel: () => PRIMARY_MODEL,
      samplePair: () => false,
      wait: async () => {},
      launcher: TEST_AI_WORK_LAUNCHER,
    };
    const committed = await commitPurchaseImport(
      ctx.db,
      preparation.commitInput,
      ctx.actor,
      undefined,
      {
        onProductsCreated: (ids) =>
          sweepImportedProductCategories(context, ids, sweepPorts),
      },
    );
    // A replay reads the ledger's original result: the sweep changed nothing.
    expect(
      await commitPurchaseImport(ctx.db, preparation.commitInput, ctx.actor),
    ).toEqual(committed);
    const purchaseCode = committed.items[0]?.purchaseId;
    const created = await getDb(ctx.db)
      .select({ id: product.id, shortcode: product.shortcode })
      .from(product);
    expect(created).toHaveLength(2);

    const [sweep] = await getDb(ctx.db)
      .select()
      .from(run)
      .where(eq(run.purpose, "suggestion_sweep"));
    expect(sweep?.trigger).toBe("scheduled");
    const input = suggestionSweepRunInput.parse(sweep?.input);
    expect(input).toMatchObject({ entity: "product", fields: ["categoryId"] });
    expect([...(input.filters.ids as string[])].sort()).toEqual(
      created.map(({ shortcode }) => shortcode).sort(),
    );

    const arrived = () =>
      getDb(ctx.db)
        .select({ status: runFinding.status })
        .from(runFinding)
        .where(
          and(
            eq(runFinding.kind, "arrived"),
            eq(runFinding.entityKind, "purchase"),
          ),
        );
    expect(await arrived()).toEqual([{ status: "open" }]);
    expect(purchaseCode).toBeTruthy();

    await driveAiWork(ctx.db, sweep!.id, {
      sweep: { context, ...sweepPorts },
    });
    expect(
      (
        await getDb(ctx.db)
          .select({ categoryId: product.categoryId })
          .from(product)
      ).map(({ categoryId }) => categoryId),
    ).toEqual([taxonomyId("food"), taxonomyId("food")]);
    expect(await arrived()).toEqual([{ status: "applied" }]);
  });
});
