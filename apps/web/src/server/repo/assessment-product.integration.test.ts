import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { enqueueProductIdentityPair } from "~/server/ai/product-identity";
import {
  evaluateProductIdentity,
  publishProductIdentity,
  productIdentitySnapshot,
} from "~/server/ai/product-identity";
import {
  aiEvaluation,
  aiEvaluationRequest,
  assessment,
  assessmentState,
  entityExternalId,
  entitySource,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  externalSource,
  product,
} from "~/server/db/schema";
import { mergeReviewedProductPair } from "~/server/repo/assessment-product";
import { reviewAssessment } from "~/server/repo/assessment-review";
import { getDb } from "~/server/repo/database-helpers";
import { canonicalJson } from "~/server/repo/entity-source";
import { listProductMatchRows } from "~/server/repo/product-match-candidate";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";
import {
  kernelCtx,
  productFixture,
  recordId,
} from "~/server/runs/suggestion-sweep.fixtures";

// Failure modes: an unavailable model hides exact rule evidence; discovery
// direction duplicates the same immutable pair; stale identity permits merge;
// merging rewrites the original subject instead of retiring current actions;
// a new scan resurfaces an unchanged pair after a member's wrong verdict.
// Shared exact claims must not merge Source-confirmed conflicting variants;
// an accepted raw style SKU is association evidence, not variant granularity.
describe("stored Product identity pairs", () => {
  const ctx = withTestDb();
  const boundVariantPair = async (
    names: readonly [string, string],
    sku?: string,
  ) => {
    const products = await Promise.all(
      names.map((name) =>
        productFixture(ctx, name, {
          model: "SYNTH-STYLE",
          manufacturer: "Synthetic apparel maker",
        }),
      ),
    );
    const ids = await Promise.all(
      products.map((row) => recordId(ctx.db, row.id, "product")),
    );
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "running",
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic variant buyer",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic variant retailer",
      website: sku ? "https://catalog.example.test" : "https://www.amazon.com",
    });
    await getDb(ctx.db)
      .insert(externalSource)
      .values({
        slug: "synthetic-variant",
        label: "Synthetic variant issuer",
        vendorId: vendor.id,
      });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-01-01",
    });
    const original = acceptedSourceOrder.parse({
      checksum: "c".repeat(64),
      extraction: {
        status: "ready",
        candidate: {
          orderId: "synthetic-variant-order",
          orderedAt: "2026-01-01T00:00:00.000Z",
          merchant: "Synthetic variant retailer",
          currency: "USD",
          printedGrandTotal: 20,
          lines: names.map((title) => ({
            title,
            amount: 10,
            lineKind: "principal",
            sku,
            productUrl: sku
              ? "https://catalog.example.test/style/family"
              : "https://www.amazon.com/dp/B000000001",
          })),
          payments: [],
          allShipmentsDelivered: false,
        },
      },
    });
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: party.id,
        kind: "vendor_export",
        externalKey: "synthetic-variant-order",
        checksum: original.checksum,
        firstRunId: runId,
        lastRunId: runId,
      })
      .returning();
    const [order] = await getDb(ctx.db)
      .insert(importSourceOrder)
      .values({
        sourceClaimId: claim!.id,
        orderKey: "synthetic-variant-order",
        purchaseId: purchase.id,
        checksum: original.checksum,
        outputFingerprint: "d".repeat(64),
        originalOrder: original,
      })
      .returning();
    await getDb(ctx.db)
      .insert(importSourceProduct)
      .values(
        ids.map((id, lineIndex) => ({
          sourceOrderId: order!.id,
          lineIndex,
          productId: id,
        })),
      );
    await getDb(ctx.db)
      .insert(entitySource)
      .values(
        await Promise.all(
          ids.flatMap((id, index) =>
            ["name", "model", "manufacturer"].map(async (fieldPath) => ({
              entityId: id,
              entityKind: "product" as const,
              fieldPath,
              valueFingerprint: await sha256Hex(
                canonicalJson(
                  fieldPath === "name"
                    ? names[index]!
                    : fieldPath === "model"
                      ? "SYNTH-STYLE"
                      : "Synthetic apparel maker",
                ),
              ),
              url: sku
                ? "https://catalog.example.test/style/family"
                : "https://www.amazon.com/dp/B000000001",
              quote:
                fieldPath === "name"
                  ? names[index]!
                  : fieldPath === "model"
                    ? `SYNTH-STYLE · ${names[index]}`
                    : `Synthetic apparel maker · ${names[index]}`,
              userId: ctx.actor.userId,
              channel: "web" as const,
            })),
          ),
        ),
      );
    return { products, ids, runId };
  };
  it.each([
    [
      "Synthetic blue medium shirt, pack of 2",
      "Synthetic red medium shirt, pack of 2",
    ],
    [
      "Synthetic blue small shirt, pack of 2",
      "Synthetic blue large shirt, pack of 2",
    ],
    [
      "Synthetic blue medium shirt, pack of 2",
      "Synthetic blue medium shirt, pack of 4",
    ],
  ] as const)(
    "refuses an exact claim with verified conflicting variants: %s / %s",
    async (first, second) => {
      const { products, ids, runId } = await boundVariantPair([first, second]);
      const result = await evaluateProductIdentity(ctx.db, ids[0]!, runId);
      expect(result.pairs).toHaveLength(1);
      expect(result.pairs[0]).toMatchObject({
        actionable: true,
        conflict: true,
      });
      await publishProductIdentity(ctx.db, result);
      const [pair] = await getDb(ctx.db)
        .select()
        .from(assessmentState)
        .where(eq(assessmentState.family, "product_pair"));
      await expect(
        mergeReviewedProductPair(kernelCtx(ctx), {
          keepId: products[0]!.id,
          mergeId: products[1]!.id,
          assessmentId: pair!.id,
          expectedFingerprint: pair!.fingerprint!,
        }),
      ).rejects.toThrow(/conflict/);
    },
  );
  it("keeps an accepted shared style SKU with different verified sizes as a recommendation", async () => {
    const { ids, runId } = await boundVariantPair(
      [
        "Synthetic blue small shirt, pack of 2",
        "Synthetic blue large shirt, pack of 2",
      ],
      "SYNTH-STYLE",
    );
    const result = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort: async () => ({
        answers: {
          selection: {
            type: "choice",
            choice: "c1",
            confidence: 0.99,
            probabilities: { c0: 0.003, c1: 0.99, c2: 0.003, c3: 0.004 },
          },
        },
      }),
    });
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      actionable: false,
      conflict: false,
    });
  });
  it("admits complete retained variants only with matching current Source receipts", async () => {
    const { ids, runId } = await boundVariantPair(
      [
        "Synthetic A blue medium shirt, pack of 2",
        "Synthetic B blue medium shirt, pack of 2",
      ],
      "SYNTH-VARIANT-2",
    );
    const result = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort: async () => {
        throw new Error("Complete retained variant must use its rule evidence");
      },
    });
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      actionable: true,
      conflict: false,
    });
  });
  it("keeps exact rule evidence available during model failure and fences a later identity edit", async () => {
    const a = await productFixture(ctx, "Synthetic catalog item A");
    const b = await productFixture(ctx, "Synthetic catalog item B");
    await productFixture(ctx, "Synthetic catalog item C");
    const aId = await recordId(ctx.db, a.id, "product"),
      bId = await recordId(ctx.db, b.id, "product");
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "running",
    });
    const party = await insertWithShortcode(ctx.db, "ledgerParty", {
      name: "Synthetic claim member",
      kind: "member",
      userId: ctx.actor.userId,
    });
    const vendor = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic claim retailer",
      website: "https://www.amazon.com",
    });
    const purchase = await insertWithShortcode(ctx.db, "purchase", {
      vendorId: vendor.id,
      date: "2026-01-01",
    });
    await getDb(ctx.db).insert(externalSource).values({
      slug: "synthetic",
      label: "Synthetic exact issuer",
      vendorId: vendor.id,
    });
    await getDb(ctx.db).insert(entityExternalId).values({
      entityKind: "product",
      entityId: aId,
      source: "synthetic",
      kind: "asin",
      externalId: "B000000001",
      isPrimary: true,
    });
    await expect(
      getDb(ctx.db).insert(entityExternalId).values({
        entityKind: "product",
        entityId: bId,
        source: "synthetic",
        kind: "asin",
        externalId: "B000000001",
        isPrimary: true,
      }),
    ).rejects.toMatchObject({ cause: { code: "23505" } });
    const unavailable = {
      decisionPort: async () => {
        throw new Error("Synthetic unavailable model");
      },
    };
    expect(
      (await evaluateProductIdentity(ctx.db, aId, runId, unavailable)).pairs,
    ).toEqual([]);
    const original = acceptedSourceOrder.parse({
      checksum: "a".repeat(64),
      extraction: {
        status: "ready",
        candidate: {
          orderId: "synthetic-claim-order",
          orderedAt: "2026-01-01T00:00:00.000Z",
          merchant: "Synthetic claim retailer",
          currency: "USD",
          printedGrandTotal: 10,
          lines: [
            {
              title: "Synthetic source variant",
              amount: 10,
              lineKind: "principal",

              productUrl: "https://www.amazon.com/dp/B000000001",
            },
          ],
          payments: [],
          allShipmentsDelivered: false,
        },
      },
    });
    const [claim] = await getDb(ctx.db)
      .insert(importSourceClaim)
      .values({
        ledgerPartyId: party.id,
        kind: "vendor_export",
        externalKey: "synthetic-claim-order",
        checksum: original.checksum,
        firstRunId: runId,
        lastRunId: runId,
      })
      .returning();
    const [order] = await getDb(ctx.db)
      .insert(importSourceOrder)
      .values({
        sourceClaimId: claim!.id,
        orderKey: "synthetic-claim-order",
        purchaseId: purchase.id,
        checksum: original.checksum,
        outputFingerprint: "b".repeat(64),
        originalOrder: original,
      })
      .returning();
    await getDb(ctx.db)
      .insert(importSourceProduct)
      .values({ sourceOrderId: order!.id, lineIndex: 0, productId: bId });
    const result = await evaluateProductIdentity(ctx.db, aId, runId, {
      decisionPort: async () => {
        throw new Error("Synthetic unavailable model");
      },
    });
    expect(result.failure).toContain("Synthetic unavailable model");
    await publishProductIdentity(ctx.db, result);
    const [pair] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.family, "product_pair"));
    expect(pair?.data).toEqual(
      expect.objectContaining({ actionable: true, conflict: false }),
    );
    await reviewAssessment(ctx.db, kernelCtx(ctx), {
      assessmentId: pair!.id,
      operationId: "synthetic-distinct-review",
      verdict: "wrong",
      intent: "history",
      correction: { present: false },
    });
    const secondRunId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "running",
      clientKey: "synthetic-opposite-review-scan",
    });
    const opposite = await evaluateProductIdentity(ctx.db, bId, secondRunId, {
      decisionPort: async () => {
        throw new Error("Synthetic unavailable model");
      },
    });
    await publishProductIdentity(ctx.db, opposite);
    expect(await getDb(ctx.db).select().from(assessment)).toHaveLength(1);
    const [reviewed] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.id, pair!.id));
    expect(reviewed).toMatchObject({ status: "rejected", suppression: null });
    expect(await listProductMatchRows(ctx.db)).toEqual([]);
    const originalProducer = (await getDb(ctx.db).select().from(assessment))[0]!
      .producer;
    expect(originalProducer?.runId).toBe(runId);
    const revised = opposite.pairs[0]!;
    await publishProductIdentity(ctx.db, {
      pairs: [
        {
          ...revised,
          producer: {
            ...revised.producer,
            revision: "synthetic-rule-revision",
          },
        },
      ],
    });
    expect(await getDb(ctx.db).select().from(assessment)).toHaveLength(2);
    expect(
      (await getDb(ctx.db).select().from(assessmentState)).filter(
        (row) => row.active,
      ),
    ).toEqual([
      expect.objectContaining({ status: "pending", suppression: null }),
    ]);
    await getDb(ctx.db)
      .update(product)
      .set({ model: "New source identity" })
      .where(eq(product.id, bId));
    await publishProductIdentity(
      ctx.db,
      await evaluateProductIdentity(ctx.db, bId, secondRunId, unavailable),
    );
    expect(await getDb(ctx.db).select().from(assessment)).toHaveLength(3);
    await expect(
      mergeReviewedProductPair(kernelCtx(ctx), {
        keepId: a.id,
        mergeId: b.id,
        assessmentId: pair!.id,
        expectedFingerprint: pair!.fingerprint!,
      }),
    ).rejects.toThrow(/stale|changed/);
    expect(
      (await productIdentitySnapshot(ctx.db, bId))?.fingerprint,
    ).toBeTruthy();
    expect((await getDb(ctx.db).select().from(assessment))[0]?.subject).toEqual(
      expect.objectContaining({
        recordId: [aId, bId].sort()[0],
        otherId: [aId, bId].sort()[1],
      }),
    );
  });
  it("shares a canonical pair execution requested by opposite catalog scans", async () => {
    const a = await productFixture(ctx, "Synthetic pair request A"),
      b = await productFixture(ctx, "Synthetic pair request B");
    const ids = await Promise.all(
      [a, b].map((row) => recordId(ctx.db, row.id, "product")),
    );
    const runs = await Promise.all(
      ["synthetic-pair-a", "synthetic-pair-b"].map((clientKey) =>
        ensureRun(ctx.db, ctx.actor, {
          purpose: "ai_suggest",
          trigger: "manual",
          status: "running",
          clientKey,
        }),
      ),
    );
    const provenance = {
      dependencies: [],
      inputFingerprint: "synthetic-pair-input",
      optionFingerprint: "synthetic-options",
      model: "typesafe/jev",
    };
    const first = await enqueueProductIdentityPair(
      ctx.db,
      [ids[0]!, ids[1]!],
      runs[0]!,
      provenance,
    );
    const other = await enqueueProductIdentityPair(
      ctx.db,
      [ids[1]!, ids[0]!],
      runs[1]!,
      provenance,
    );
    expect(other.id).toBe(first.id);
    expect(await getDb(ctx.db).select().from(aiEvaluation)).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(aiEvaluationRequest)).toHaveLength(
      2,
    );
  });
  it("keeps a same-URL partial variant and model verdict as a recommendation", async () => {
    const a = await productFixture(ctx, "Synthetic partial A"),
      b = await productFixture(ctx, "Synthetic partial B");
    const ids = await Promise.all(
      [a, b].map((row) => recordId(ctx.db, row.id, "product")),
    );
    const modelFingerprint = await sha256Hex(canonicalJson("TEST-123"));
    await getDb(ctx.db)
      .insert(entitySource)
      .values(
        ids.map((id) => ({
          entityId: id,
          entityKind: "product" as const,
          fieldPath: "model",
          valueFingerprint: modelFingerprint,
          selectedVariant: "blue",
          url: "https://catalog.example.test/style/family",
          quote: "Blue style family",
          userId: ctx.actor.userId,
          channel: "web" as const,
        })),
      );
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "running",
    });
    const result = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort: async () => ({
        answers: {
          selection: {
            type: "choice",
            choice: "c0",
            confidence: 0.99,
            probabilities: { c0: 0.99, c1: 0.003, c2: 0.003, c3: 0.004 },
          },
        },
      }),
    });
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      actionable: false,
      conflict: false,
    });
  });
});
