import {
  type ConnectionCandidate,
  connectionCandidate,
} from "@cubby/schemas/entity-connections";
import { createRepoEntity } from "tooling/factories/repo";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { getDb } from "~/server/db/helpers";
import { entityLink, financialTransactionAllocation } from "~/server/db/schema";
import { deletePurchases } from "~/server/domains/purchase/repo/purchase";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";

import {
  captureConnectionBasis,
  prepareConnectionBases,
} from "./connection-evidence";

// Freshness checks capture many bases from prepared, batched reads. Each must
// equal the basis the same candidate captures alone, and an endpoint that no
// longer resolves must still fail the capture.
describe("prepared connection bases", () => {
  const ctx = withTestDb();

  it("capture exactly the per-candidate basis", async () => {
    const vendor = await createRepoEntity(ctx, "vendor", {
      name: "Synthetic basis supplier",
    });
    const account = await createRepoEntity(ctx, "financialAccount", {
      name: "Synthetic basis card",
      identity: { kind: "cash" },
    });
    const [order, gone] = await Promise.all([
      createRepoEntity(ctx, "purchase", {
        vendorId: vendor.output.id,
        date: "2026-09-10",
        statedTotal: 40,
      }),
      createRepoEntity(ctx, "purchase", {
        vendorId: vendor.output.id,
        date: "2026-09-11",
      }),
    ]);
    const [charge, refund] = await Promise.all([
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        amount: 40,
        kind: "purchase",
        status: "posted",
        postedDate: "2026-09-12",
        merchant: "Synthetic basis supplier",
      }),
      createRepoEntity(ctx, "financialTransaction", {
        accountId: account.output.id,
        amount: -5,
        kind: "refund",
        status: "posted",
        postedDate: "2026-09-14",
      }),
    ]);
    const project = await createRepoEntity(ctx, "project", {
      name: "Synthetic basis project",
    });
    const product = await insertWithShortcode(ctx.db, "product", {
      name: "Synthetic basis drill",
      manufacturer: "Synthetic maker",
    });
    const line = await createRepoEntity(ctx, "expense", {
      name: "Synthetic basis line",
      date: "2026-09-10",
      trade: "electrical",
      costType: "materials",
      cost: 40,
      purchaseId: order.output.id,
    });
    // Payload rows each relation reads: an allocation of the charge, and a
    // linked line of the Product on the order.
    await getDb(ctx.db).insert(financialTransactionAllocation).values({
      transactionId: charge.entityId,
      purchaseId: order.entityId,
      amount: 25,
    });
    await getDb(ctx.db)
      .insert(entityLink)
      .values({
        kind: "purchaseProduct",
        fromEntityId: order.entityId,
        fromKind: "purchase",
        toEntityId: product.id,
        toKind: "product",
      } as typeof entityLink.$inferInsert);
    await createRepoEntity(ctx, "expense", {
      name: "Synthetic basis drill line",
      date: "2026-09-10",
      trade: "electrical",
      costType: "tools",
      cost: 15,
      productId: product.shortcode,
      purchaseId: order.output.id,
    });
    const evidence = { reasons: [], contradictions: [], unknowns: [] };
    const candidate = (
      relation: ConnectionCandidate["relation"],
      source: { entityKind: string; entityId: string },
      target: { entityKind: string; entityId: string },
    ): ConnectionCandidate =>
      connectionCandidate.parse({
        relation,
        source,
        target,
        label: "Synthetic candidate",
        evidence,
      });
    const ref = (entityKind: string, entityId: string) => ({
      entityKind,
      entityId,
    });
    const candidates = [
      candidate(
        "expense-project",
        ref("expense", line.output.id),
        ref("project", project.output.id),
      ),
      candidate(
        "transaction-purchase",
        ref("financialTransaction", charge.output.id),
        ref("purchase", order.output.id),
      ),
      candidate(
        "transaction-refund",
        ref("financialTransaction", refund.output.id),
        ref("purchase", order.output.id),
      ),
      candidate(
        "project-tool",
        ref("project", project.output.id),
        ref("product", product.shortcode),
      ),
      candidate(
        "product-purchase",
        ref("product", product.shortcode),
        ref("purchase", order.output.id),
      ),
    ];
    const missing = candidate(
      "transaction-purchase",
      ref("financialTransaction", charge.output.id),
      ref("purchase", gone.output.id),
    );
    await deletePurchases(ctx.db, [gone.output.id], ctx.actor);
    const prepared = await prepareConnectionBases(ctx.db, [
      ...candidates,
      missing,
    ]).catch((error: unknown) => error);
    // A missing Purchase fails the whole batch exactly as it fails alone.
    await expect(captureConnectionBasis(ctx.db, missing)).rejects.toThrow(
      "Purchase not found",
    );
    expect(prepared).toBeInstanceOf(Error);
    const ready = await prepareConnectionBases(ctx.db, candidates);
    for (const raw of candidates)
      expect(
        canonicalJson(await captureConnectionBasis(ctx.db, raw, false, ready)),
      ).toBe(canonicalJson(await captureConnectionBasis(ctx.db, raw)));
  });
});
