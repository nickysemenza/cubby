import { eq, inArray } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { getDb } from "~/server/db/helpers";
import {
  assessment,
  assessmentState,
  feedback,
  inventoryEntry,
  product,
} from "~/server/db/schema";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import {
  prepareProductIdentityPair,
  prepareProductIdentityPairs,
  productIdentityPairKey,
} from "~/server/domains/product/repo/match/product-identity-snapshot";
import { publishProductPair } from "~/server/domains/product/repo/match/product-match-candidate";
import { mergeProducts } from "~/server/domains/product/repo/merge";
import { groundedVariantEvidence } from "~/server/domains/product/repo/product-variant-evidence";
import {
  kernelCtx,
  productFixture,
  recordId,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { executeEntity } from "~/server/entity-kernel";
import { mergeReviewedProductPair } from "~/server/generic/assessment/repo/assessment-product";
import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

type PairIds = Parameters<typeof prepareProductIdentityPair>[1];

// Historical receipts remain readable guards after their live Source verifier is retired.
const historicalVariants = (ids: PairIds) =>
  groundedVariantEvidence.parse({
    producer: {
      kind: "model",
      model: "typesafe/jev",
      revision: "synthetic-legacy",
      runId: null,
      evaluationId: null,
    },
    inputFingerprint: "synthetic-legacy",
    priorConflictIds: [],
    dependencies: [],
    dimensions: ["color", "size", "pack"].map((dimension) => ({
      dimension,
      first:
        dimension === "color"
          ? {
              productId: ids[0],
              sourceId: crypto.randomUUID(),
              field: "name",
              valueFingerprint: "synthetic-legacy",
              quote: "blue",
              start: 0,
              end: 4,
              value: "blue",
              binding: "unambiguous",
              selectedVariant: null,
            }
          : null,
      second:
        dimension === "color"
          ? {
              productId: ids[1],
              sourceId: crypto.randomUUID(),
              field: "name",
              valueFingerprint: "synthetic-legacy",
              quote: "red",
              start: 0,
              end: 3,
              value: "red",
              binding: "unambiguous",
              selectedVariant: null,
            }
          : null,
      relation: dimension === "color" ? "different" : "unknown",
      decisions: [],
    })),
  });

describe("retained Product identity conflict guards", () => {
  const ctx = withTestDb();
  const pair = async () => {
    const first = await productFixture(ctx, "Synthetic history first", {
      model: "SYNTH-SAME",
    });
    const second = await productFixture(ctx, "Synthetic history second", {
      model: "SYNTH-SAME",
    });
    const ids: PairIds = [
      await recordId(ctx.db, first.id, "product"),
      await recordId(ctx.db, second.id, "product"),
    ];
    return { first, second, ids };
  };
  const retainHistory = async (
    ids: PairIds,
    signals: z.infer<ReturnType<typeof z.json>>,
    conflict = true,
  ) => {
    const fingerprint =
      (await prepareProductIdentityPair(ctx.db, ids, { includeExcluded: true }))
        ?.fingerprint ?? null;
    const [first, second] = [...ids].sort();
    const [row] = await getDb(ctx.db)
      .insert(assessment)
      .values({
        publicationKey: `synthetic:historical:${crypto.randomUUID()}`,
        family: "product_pair",
        subject: {
          kind: "product_pair",
          entity: "product",
          recordId: first!,
          otherId: second!,
        },
        judgment: { actionable: true, conflict },
        evidence: { conflict, signals },
        served: true,
        fingerprint,
      })
      .returning();
    return row!;
  };

  it("allows an explicit merge after identity inputs change without clearing historical advice", async () => {
    const { first, second, ids } = await pair();
    await retainHistory(ids, {
      snapshots: [{ verifiedModel: "SYNTH-A" }, { verifiedModel: "SYNTH-B" }],
    });
    await getDb(ctx.db)
      .update(product)
      .set({
        brandId: await findOrCreateVendor(ctx.db, "Corrected synthetic maker"),
      })
      .where(inArray(product.id, [...ids]));
    expect(await prepareProductIdentityPair(ctx.db, ids)).toMatchObject({
      conflict: false,
      verification: "pending_verification",
    });
    await expect(
      mergeProducts(
        ctx.db,
        { keepId: first.id, mergeIds: [second.id] },
        ctx.actor,
      ),
    ).resolves.toBeDefined();
  });

  it.each(["legacy_model", "legacy_variant", "unknown"])(
    "does not clear a historical %s conflict with equal model text or notes",
    async (kind) => {
      const { first, second, ids } = await pair();
      const history = await retainHistory(
        ids,
        kind === "legacy_model"
          ? {
              snapshots: [
                { verifiedModel: "SYNTH-A" },
                { verifiedModel: "SYNTH-B" },
              ],
            }
          : kind === "legacy_variant"
            ? { variantEvidence: historicalVariants(ids) }
            : {},
      );
      await getDb(ctx.db)
        .update(product)
        .set({
          notes:
            "Verified blue medium exact same item https://catalog.example.test/same",
        })
        .where(inArray(product.id, [...ids]));
      const prepared = await prepareProductIdentityPair(ctx.db, ids);
      expect(prepared).toMatchObject({
        conflict: false,
        verification: "pending_verification",
        priorConflictIds: [history.id],
        variantEvidence: null,
      });
      const proposal = await publishProductPair(ctx.db, {
        productIds: ids,
        source: "agent",
        evidence: "Synthetic same item claim",
        sourceUrls: [],
        fingerprint: prepared!.fingerprint,
      });
      await expect(
        mergeReviewedProductPair(kernelCtx(ctx), {
          keepId: first.id,
          mergeId: second.id,
          assessmentId: proposal.id,
          expectedFingerprint: proposal.fingerprint!,
        }),
      ).rejects.toThrow(/identity conflict|evidence changed/);
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(assessment)
            .where(eq(assessment.id, history.id))
        )[0]?.evidence,
      ).toEqual(history.evidence);
    },
  );

  it("keeps a newly recorded model conflict pending after current models are made equal", async () => {
    const { ids } = await pair();
    await getDb(ctx.db)
      .update(product)
      .set({ model: "SYNTH-OTHER" })
      .where(eq(product.id, ids[1]));
    const prepared = await prepareProductIdentityPair(ctx.db, ids);
    expect(prepared?.conflict).toBe(true);
    const prior = await publishProductPair(ctx.db, {
      productIds: ids,
      source: "agent",
      evidence: "Synthetic differing models",
      sourceUrls: [],
      conflict: prepared!.conflict,
      signals: { snapshots: [prepared!.first, prepared!.second] },
    });
    await getDb(ctx.db)
      .update(product)
      .set({ model: "SYNTH-SAME" })
      .where(eq(product.id, ids[1]));
    expect(await prepareProductIdentityPair(ctx.db, ids)).toMatchObject({
      conflict: false,
      verification: "pending_verification",
      priorConflictIds: [prior.id],
    });
    const third = await productFixture(ctx, "Synthetic unrelated variant", {
      model: "SYNTH-SAME",
    });
    const thirdId = await recordId(ctx.db, third.id, "product");
    const pairs = await prepareProductIdentityPairs(ctx.db, [
      [ids[1], ids[0]],
      [ids[0], thirdId],
    ]);
    expect(pairs.get(productIdentityPairKey(ids))).toEqual(
      await prepareProductIdentityPair(ctx.db, ids),
    );
    expect(pairs.get(productIdentityPairKey([ids[0], thirdId]))).toMatchObject({
      verification: "unknown",
      priorConflictIds: [],
    });
  });

  it("does not promote old positive literal receipts to current verification", async () => {
    const { ids } = await pair();
    const old = historicalVariants(ids);
    const positive = {
      ...old,
      dimensions: old.dimensions.map((row) => ({ ...row, relation: "same" })),
    };
    await retainHistory(ids, { variantEvidence: positive }, false);
    const proposal = await publishProductPair(ctx.db, {
      productIds: ids,
      source: "agent",
      evidence: "Synthetic positive receipt",
      sourceUrls: [],
      signals: { variantEvidence: positive },
    });
    expect(proposal).toMatchObject({
      conflict: false,
      verification: "unknown",
    });
    expect(await prepareProductIdentityPair(ctx.db, ids)).toMatchObject({
      verification: "unknown",
      variantEvidence: null,
    });
  });

  it("carries unresolved legacy variant conflict lineage through consecutive merges", async () => {
    const { first, second, ids } = await pair();
    const history = await retainHistory(
      ids,
      { variantEvidence: historicalVariants(ids) },
      false,
    );
    await publishProductPair(ctx.db, {
      productIds: ids,
      source: "agent",
      evidence: "Synthetic descendant",
      sourceUrls: [],
    });
    let previous = first;
    for (const name of [
      "Synthetic first replacement",
      "Synthetic second replacement",
    ]) {
      const keeper = await productFixture(ctx, name, { model: null });
      const keeperId = await recordId(ctx.db, keeper.id, "product");
      await mergeProducts(
        ctx.db,
        { keepId: keeper.id, mergeIds: [previous.id] },
        ctx.actor,
      );
      const remaining = await prepareProductIdentityPair(ctx.db, [
        keeperId,
        ids[1],
      ]);
      expect(remaining).toMatchObject({
        conflict: false,
        verification: "pending_verification",
        priorConflictIds: expect.arrayContaining([history.id]),
      });
      const proposal = await publishProductPair(ctx.db, {
        productIds: [keeperId, ids[1]],
        source: "agent",
        evidence: "Synthetic post-merge proposal",
        sourceUrls: [],
      });
      await expect(
        mergeReviewedProductPair(kernelCtx(ctx), {
          keepId: keeper.id,
          mergeId: second.id,
          assessmentId: proposal.id,
          expectedFingerprint: proposal.fingerprint!,
        }),
      ).rejects.toThrow(/identity conflict|evidence changed/);
      previous = keeper;
    }
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(assessment)
          .where(eq(assessment.id, history.id))
      )[0]?.subject,
    ).toEqual(history.subject);
  });

  it.each(
    [false, true].flatMap((multiway) =>
      ["current", "historical", "excluded"].map((evidence) => ({
        multiway,
        evidence,
      })),
    ),
  )(
    "refuses every combined conflicting pair atomically: %j",
    async ({ multiway, evidence }) => {
      const { first, second, ids } = await pair();
      if (evidence === "current") {
        await getDb(ctx.db)
          .update(product)
          .set({ model: "SYNTH-DIFFERENT" })
          .where(eq(product.id, ids[1]));
      } else {
        if (evidence === "excluded")
          await getDb(ctx.db)
            .update(product)
            .set({ name: "Misc" })
            .where(eq(product.id, ids[1]));
        await retainHistory(ids, { variantEvidence: historicalVariants(ids) });
      }
      const neutral = await productFixture(ctx, "Synthetic neutral keeper", {
        model: null,
      });
      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Synthetic guarded shelf" }),
        ctx.actor,
      );
      for (const id of ids)
        await createInventoryEntry(
          ctx.db,
          {
            productId: id,
            locationId: location.entityId,
            amount: { value: 2, unit: "each" },
          },
          ctx.actor,
        );
      const readPreserved = () =>
        Promise.all([
          getDb(ctx.db).select().from(product).orderBy(product.id),
          getDb(ctx.db)
            .select()
            .from(inventoryEntry)
            .orderBy(inventoryEntry.id),
          getDb(ctx.db).select().from(assessment).orderBy(assessment.id),
          getDb(ctx.db)
            .select()
            .from(assessmentState)
            .orderBy(assessmentState.id),
          getDb(ctx.db).select().from(feedback).orderBy(feedback.id),
        ]);
      const before = await readPreserved();
      const input = {
        keepId: multiway ? neutral.id : first.id,
        mergeIds: multiway ? [first.id, second.id] : [second.id],
      };
      await expect(
        executeEntity(kernelCtx(ctx), {
          action: "merge",
          entity: "product",
          data: input,
        }),
      ).rejects.toThrow(/conflict|verification/);
      expect(await readPreserved()).toEqual(before);
      await expect(mergeProducts(ctx.db, input, ctx.actor)).rejects.toThrow(
        /conflict|verification/,
      );
      expect(await readPreserved()).toEqual(before);
    },
  );
});
