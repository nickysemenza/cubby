import { parseEntityId } from "@cubby/schemas/identifiers";
import type { ExtractedOrderCandidate } from "@cubby/schemas/purchase-import";
import { sweepRunInput } from "@cubby/schemas/run-fields";
import { sql } from "drizzle-orm";
import { and, eq } from "drizzle-orm";
import { driveAiWork } from "tooling/ai-work";
import { taxonomyId } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { fieldAsk, fieldAskInput } from "~/server/ai/fields/ask";
import { getDb } from "~/server/db/helpers";
import { product, productCategory, run } from "~/server/db/schema";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  categoryPorts,
  kernelCtx,
  PRIMARY_MODEL,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { resolveOrThrow } from "~/server/generic/shortcode/repo/shortcode-resolver";
import {
  runFinding,
  seedRunFinding,
} from "~/server/testing/run-finding.fixtures";

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
    await getDb(ctx.db)
      .update(productCategory)
      .set({ stockTracked: false })
      .where(eq(productCategory.id, taxonomyId("food")));
    const { vendor, party } = await memberImportWorld(ctx.db, ctx.actor, {
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
    // The sweep nests under the import Run without joining it.
    const importRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "file_import",
      trigger: "manual",
      status: "running",
    });
    const sweepPorts = {
      ...categoryPorts(),
      decisionModel: () => PRIMARY_MODEL,
      wait: async () => {},
    };
    const committed = await commitPurchaseImport(
      ctx.db,
      preparation.commitInput,
      ctx.actor,
      undefined,
      {
        onProductsCreated: (ids) =>
          sweepImportedProductCategories(
            {
              ...context,
              actorContext: { ...context.actorContext, runId: importRunId },
            },
            ids,
          ),
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
      .where(eq(run.purpose, "sweep"));
    expect(sweep).toMatchObject({
      trigger: "scheduled",
      cause: "import_completed",
      parentRunId: importRunId,
    });
    const family = sweepRunInput
      .parse(sweep?.input)
      .families.find((entry) => entry.family === "field");
    if (family?.family !== "field")
      throw new Error("Synthetic field scope is missing");
    const input = family.scope.targets![0]!;
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
    expect(await arrived()).toEqual([]);
    expect(purchaseCode).toBeTruthy();
    // Existing receiving findings remain actionable; new extraction no longer creates them.
    const purchaseId = await resolveOrThrow(ctx.db, "purchase", purchaseCode!);
    await seedRunFinding(ctx.db, {
      ledgerPartyId: parseEntityId("ledgerParty", party.id),
      entityKind: "purchase",
      entityId: purchaseId,
      kind: "arrived",
      summary: "Synthetic historical delivery finding",
      proposedFix: { kind: "receive_purchase", purchaseId },
      evidenceFingerprint: "synthetic-historical-arrival",
    });
    expect(await arrived()).toEqual([{ status: "open" }]);

    await driveAiWork(
      ctx.db,
      sweep!.id,
      {
        sweep: { context, ...sweepPorts },
      },
      undefined,
      async () => {
        const queued = await getDb(ctx.db).execute<{
          input: { input: unknown };
        }>(
          sql`SELECT k.input FROM "Ask" k JOIN "AskScope" s ON s."askId"=k.id WHERE s."runId"=${sweep!.id} AND k.feature=${"field-suggestion"} AND k.state=${"queued"}`,
        );
        const { withAsk, reconcileNow } = await import("~/server/kernel/api");
        for (const row of queued.rows) {
          const input = fieldAskInput.parse(row.input.input);
          await withAsk(
            ctx.db,
            {
              ...fieldAsk,
              admit: async () => {},
              produce: async () => ({
                output: {
                  outcome: "pick",
                  proposal:
                    input.field === "categoryId"
                      ? {
                          value: taxonomyId("food"),
                          label: "Food",
                          confidence: 0.97,
                          runnerUp: null,
                        }
                      : null,
                },
              }),
            },
            input,
            { runId: sweep!.id },
          );
        }
        await reconcileNow(
          ctx.db,
          created.map((row) => ({ kind: "fields", key: `product:${row.id}` })),
          { runId: sweep!.id },
        );
      },
    );
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
