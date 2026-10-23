import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { SHORTCODE_CHARS } from "@cubby/shared";
import { eq, inArray } from "drizzle-orm";
import { countTestDbQueries, withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { DecisionPort } from "~/server/ai/decision-model";
import { PRODUCT_IDENTITY_FEATURE } from "~/server/ai/policy/feature-identity";
import { compiledRefreshManifest } from "~/server/ai/policy/refresh-manifest";
import {
  evaluateProductIdentity,
  retrieveProductIdentityCandidates,
} from "~/server/ai/product-identity";
import {
  claimAiEvaluation,
  publishAiEvaluation,
} from "~/server/ai/repo/ai-evaluation";
import {
  activateAiRefresh,
  saveAiDiscoveryCursor,
} from "~/server/ai/repo/ai-refresh";
import { getDb } from "~/server/db/helpers";
import {
  aiEvaluation,
  aiEvaluationRequest,
  assessment,
  assessmentState,
  entityExternalId,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  externalSource,
  product,
} from "~/server/db/schema";
import {
  prepareProductIdentityPairRequest,
  productIdentitySnapshot,
  prepareProductIdentityPair,
  preparedProductIdentityPair,
} from "~/server/domains/product/repo/match/product-identity-snapshot";
import {
  listProductMatchRows,
  publishProductPair,
  prepareProductPairPublication,
} from "~/server/domains/product/repo/match/product-match-candidate";
import { getProductMatchQueue } from "~/server/domains/product/repo/match/product-match-review";
import { loadProductIdentifierClaims } from "~/server/domains/product/repo/product-identity-claims";
import { ensureRun } from "~/server/domains/run/repo/ensure-run";
import {
  discoverAiRefresh,
  executeAiRefreshTarget,
} from "~/server/domains/run/service/ai-refresh";
import {
  kernelCtx,
  productFixture,
  recordId,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { findOrCreateVendor } from "~/server/domains/vendor/repo/vendor";
import { mergeReviewedProductPair } from "~/server/generic/assessment/repo/assessment-product";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { findDuplicateProductIdentities } from "~/server/generic/problems/repo/detectors-product";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { withJobFixtureExecution } from "~/server/testing/background-queue";
import { insertEntityFixtures } from "~/server/testing/repo.fixtures";

const identityPort: DecisionPort = async () => ({
  answers: {
    selection: {
      type: "choice",
      choice: "c0",
      confidence: 0.99,
      probabilities: { c0: 0.99, c1: 0.003, c2: 0.003, c3: 0.004 },
    },
  },
});

// Failure modes: an unavailable model hides exact rule evidence; discovery
// direction duplicates the same immutable pair; stale identity permits merge;
// merging rewrites the original subject instead of retiring current actions;
// a new scan resurfaces an unchanged pair after a member's wrong verdict.
// Shared exact claims must not merge current model or historical conflicts;
// an accepted raw style SKU is association evidence, not variant granularity.
// Agent proposals and equal models must not erase historical conflicts; old policies
// must not authorize an unchanged-fingerprint merge after rule activation.
async function publishProductIdentity(
  db: Parameters<typeof prepareProductPairPublication>[0],
  result: Pick<Awaited<ReturnType<typeof evaluateProductIdentity>>, "pairs">,
) {
  for (const pair of result.pairs)
    await (
      await prepareProductPairPublication(db, pair)
    )(db);
}

async function requestProductIdentityPair(
  db: Parameters<typeof prepareProductIdentityPair>[0],
  ids: Parameters<typeof prepareProductIdentityPair>[1],
  runId: Parameters<typeof prepareProductIdentityPairRequest>[2],
  provenance: Parameters<typeof prepareProductIdentityPairRequest>[3],
) {
  const pair = await prepareProductIdentityPair(db, ids);
  if (!pair) throw new Error("Synthetic Product pair is missing");
  return (await prepareProductIdentityPairRequest(db, pair, runId, provenance))(
    db,
  );
}

describe("stored Product identity pairs", () => {
  const ctx = withTestDb();
  // Suppression and weak recommendations cannot consume an actionable query's capacity.
  it.each([
    { suppressed: 200, weak: 0, actionable: 1 },
    { suppressed: 0, weak: 200, actionable: 201 },
  ])(
    "exposes open pairs beyond suppressed and weak rows: %j",
    async ({ suppressed, weak, actionable }) => {
      const count = suppressed + weak + actionable;
      const queueBrandId = await findOrCreateVendor(
        ctx.db,
        "Synthetic queue maker",
      );
      const products = Array.from({ length: count + 1 }, (_, index) => {
        let value = index;
        let body = "";
        for (let digit = 0; digit < 4; digit++) {
          body = SHORTCODE_CHARS.charAt(value % SHORTCODE_CHARS.length) + body;
          value = Math.floor(value / SHORTCODE_CHARS.length);
        }
        return {
          id: parseEntityId(
            "product",
            `20000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          ),
          shortcode: parseShortcodeFor("product", `PRD-${body}`),
          name: `Synthetic queue item ${index}`,
          brandId: queueBrandId,
        };
      });
      await insertEntityFixtures(ctx.db, product, "product", products);
      const anchor = products[0]!;
      // Detector rows carry the pair snapshot their publication froze; the
      // queue hides any whose Products have since changed.
      const fingerprints: string[] = [];
      for (const row of products.slice(1)) {
        const pair = await prepareProductIdentityPair(ctx.db, [
          anchor.id,
          row.id,
        ]);
        if (!pair) throw new Error("Synthetic queue pair is missing");
        fingerprints.push(pair.fingerprint);
      }
      const predictions = products.slice(1).map((row, index) => ({
        id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        publicationKey: `synthetic:queue-limit:${index}`,
        family: "product_pair" as const,
        fingerprint: fingerprints[index]!,
        subject: {
          kind: "product_pair" as const,
          entity: "product" as const,
          recordId: anchor.id,
          otherId: row.id,
        },
        judgment: {
          actionable: index < suppressed || index >= suppressed + weak,
          conflict: false,
        },
      }));
      await getDb(ctx.db).insert(assessment).values(predictions);
      await getDb(ctx.db)
        .insert(assessmentState)
        .values(
          predictions.map((prediction, index) => ({
            id: prediction.id,
            family: prediction.family,
            entity: "product",
            recordId: anchor.id,
            fingerprint: prediction.fingerprint,
            status:
              index < suppressed ? ("resolved" as const) : ("pending" as const),
            suppression:
              index < suppressed
                ? {
                    scope: "product_pair" as const,
                    candidateKey: `${anchor.id}|${prediction.subject.otherId}`,
                    fingerprint: null,
                  }
                : null,
            data: {
              otherId: prediction.subject.otherId,
              source:
                actionable > 1 && index === count - 1 ? "agent" : "detector",
              evidence: "Synthetic retained pair",
              sourceUrls: [],
              actionable: prediction.judgment.actionable,
              conflict: false,
            },
          })),
        );
      // Live snapshot fences read each Product once, never once per pair side.
      const { result: queue, queryCount } = await countTestDbQueries(() =>
        getProductMatchQueue(ctx.db, {}),
      );
      expect(queryCount).toBeLessThan(2 * products.length);
      expect(queue.items).toHaveLength(Math.min(200, weak + actionable));
      const problems = (await findDuplicateProductIdentities(ctx.db)).flatMap(
        (group) => group.pairs,
      );
      expect(problems).toHaveLength(actionable);
      const last = predictions.at(-1)!;
      expect(queue.items[0]?.assessmentId).toBe(last.id);
      expect(problems.map((pair) => pair.assessmentId)).toContain(last.id);
      const focused = await getProductMatchQueue(ctx.db, {
        productId: anchor.shortcode,
        candidateId: products.at(-1)!.shortcode,
      });
      expect(focused.items.map((pair) => pair.assessmentId)).toEqual([last.id]);
    },
  );
  const acceptedIdentityPair = async (
    names: readonly [string, string],
    sku?: string,
  ) => {
    const products = await Promise.all(
      names.map(async (name) =>
        productFixture(ctx, name, {
          model: "SYNTH-STYLE",
          brandId: await findOrCreateVendor(ctx.db, "Synthetic apparel maker"),
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
    await getDb(ctx.db).insert(externalSource).values({
      slug: "synthetic-variant",
      label: "Synthetic variant issuer",
      vendorId: vendor.id,
      issuer: true,
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
    return { products, ids, runId, decisionPort: identityPort };
  };
  it("hides changed detector advice before any retirement pass while retaining history", async () => {
    const { ids, runId, decisionPort } = await acceptedIdentityPair([
      "Synthetic stale pair A",
      "Synthetic stale pair B",
    ]);
    await publishProductIdentity(
      ctx.db,
      await evaluateProductIdentity(ctx.db, ids[0]!, runId, { decisionPort }),
    );
    const before = await getProductMatchQueue(ctx.db, {});
    expect(before.items).toHaveLength(1);
    await getDb(ctx.db)
      .update(product)
      .set({ model: "SYNTH-CHANGED" })
      .where(eq(product.id, ids[1]!));
    expect((await getProductMatchQueue(ctx.db, {})).items).toEqual([]);
    expect(await getDb(ctx.db).select().from(assessment)).toHaveLength(1);
  });
  // Claim loading must share issuer reads across accepted lines, while a later
  // operation must observe current registry ownership instead of a stale cache.
  it("loads retained identifier issuers in a constant query budget", async () => {
    const { ids } = await acceptedIdentityPair(
      ["Synthetic batch identity alpha", "Synthetic batch identity beta"],
      "SYNTHETIC-SHARED-SKU",
    );
    const other = await insertWithShortcode(ctx.db, "vendor", {
      name: "Synthetic second issuer",
      website: "https://other.example.test",
    });
    await getDb(ctx.db).insert(externalSource).values({
      slug: "synthetic-second-issuer",
      label: "Synthetic second issuer",
      vendorId: other.id,
      issuer: true,
    });
    const [order] = await getDb(ctx.db).select().from(importSourceOrder);
    const original = acceptedSourceOrder.parse(order!.originalOrder);
    if (original.extraction.status !== "ready")
      throw new Error("Synthetic accepted order is not ready");
    original.extraction.candidate.lines[1]!.productUrl =
      "https://other.example.test/p/1";
    await getDb(ctx.db)
      .update(importSourceOrder)
      .set({ originalOrder: original })
      .where(eq(importSourceOrder.id, order!.id));
    const { result, queryCount } = await countTestDbQueries(() =>
      loadProductIdentifierClaims(ctx.db),
    );
    expect(
      result.map(({ productId, source, value }) => ({
        productId,
        source,
        value,
      })),
    ).toEqual(
      expect.arrayContaining(
        ids.map((productId, index) => ({
          productId,
          source: index ? "synthetic-second-issuer" : "synthetic-variant",
          value: "SYNTHETIC-SHARED-SKU",
        })),
      ),
    );
    expect(result).toHaveLength(2);
    expect(queryCount).toBeLessThanOrEqual(3);
    await getDb(ctx.db)
      .update(externalSource)
      .set({ vendorId: null })
      .where(
        inArray(externalSource.slug, [
          "synthetic-variant",
          "synthetic-second-issuer",
        ]),
      );
    expect(await loadProductIdentifierClaims(ctx.db)).toEqual([]);
  });

  // Regression: one unresolvable issuer threw inside the catalog-wide claim
  // load and failed the duplicate detector for every Product.
  it("drops only the claim whose issuer cannot resolve and reports it raw", async () => {
    const { ids } = await acceptedIdentityPair(
      ["Synthetic dropped claim alpha", "Synthetic dropped claim beta"],
      "SYNTHETIC-DROPPED-SKU",
    );
    for (const name of ["Synthetic host claimant", "Synthetic host rival"])
      await insertWithShortcode(ctx.db, "vendor", {
        name,
        website: "https://contested.example.test",
      });
    const [order] = await getDb(ctx.db).select().from(importSourceOrder);
    const original = acceptedSourceOrder.parse(order!.originalOrder);
    if (original.extraction.status !== "ready")
      throw new Error("Synthetic accepted order is not ready");
    original.extraction.candidate.lines[1]!.productUrl =
      "https://contested.example.test/p/1";
    await getDb(ctx.db)
      .update(importSourceOrder)
      .set({ originalOrder: original })
      .where(eq(importSourceOrder.id, order!.id));
    const dropped: unknown[] = [];
    const claims = await loadProductIdentifierClaims(ctx.db, undefined, {
      onDropped: (claim) => dropped.push(claim),
    });
    expect(claims.map((claim) => claim.productId)).toEqual([ids[0]]);
    expect(dropped).toEqual([
      expect.objectContaining({
        productId: ids[1],
        productUrl: "https://contested.example.test/p/1",
        error: expect.stringContaining("ambiguous"),
      }),
    ]);
    const retrieval = await retrieveProductIdentityCandidates(ctx.db, ids[0]!);
    expect(retrieval.coverage.droppedClaims).toHaveLength(1);
    expect(retrieval.coverage.semanticNeighbours).toEqual({
      status: "unconfigured",
    });
  });
  it("blocks differing current models without citations despite an exact identifier", async () => {
    const { products, ids, runId } = await acceptedIdentityPair([
      "Synthetic current model A",
      "Synthetic current model B",
    ]);
    await getDb(ctx.db)
      .update(product)
      .set({ model: "SYNTH-OTHER", notes: "Same item according to research" })
      .where(eq(product.id, ids[1]!));
    const result = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort: identityPort,
    });
    expect(result.pairs[0]).toMatchObject({
      actionable: true,
      conflict: true,
      signals: { variantEvidence: null },
    });
    await publishProductIdentity(ctx.db, result);
    const candidate = (await getProductMatchQueue(ctx.db, {})).items[0]!;
    expect(candidate.identityConflict).toBe(true);
    expect(candidate.conflictReasons).toEqual([
      expect.stringMatching(/^Model:/),
    ]);
    await expect(
      mergeReviewedProductPair(kernelCtx(ctx), {
        keepId: products[0]!.id,
        mergeId: products[1]!.id,
        assessmentId: candidate.assessmentId,
        expectedFingerprint: candidate.fingerprint!,
      }),
    ).rejects.toThrow(/conflict/);
  });
  it("refuses a completed prior-rule admission with unchanged evidence", async () => {
    const { products, ids, runId, decisionPort } = await acceptedIdentityPair(
      [
        "Synthetic prior blue medium shirt, pack of 2",
        "Synthetic next red medium shirt, pack of 2",
      ],
      "SYNTH-STYLE",
    );
    const pair = await prepareProductIdentityPair(ctx.db, [ids[0]!, ids[1]!]);
    const command = {
      keepId: products[0]!.id,
      mergeId: products[1]!.id,
      expectedFingerprint: pair!.fingerprint,
    };
    const prior = await publishProductPair(ctx.db, {
      productIds: pair!.productIds,
      source: "detector",
      evidence: "Synthetic prior policy result",
      sourceUrls: [],
      actionable: true,
      fingerprint: pair!.fingerprint,
      producer: {
        kind: "rule",
        model: null,
        revision: "identity-v5",
        runId,
        evaluationId: null,
      },
    });
    await expect(
      mergeReviewedProductPair(kernelCtx(ctx), {
        ...command,
        assessmentId: prior.id,
      }),
    ).rejects.toThrow(/obsolete|admission/);
    const weak = await publishProductPair(ctx.db, {
      productIds: pair!.productIds,
      source: "detector",
      evidence: "Synthetic prior weak result",
      sourceUrls: [],
      actionable: false,
      conflict: false,
      fingerprint: pair!.fingerprint,
      producer: {
        kind: "model",
        model: "typesafe/jev",
        revision: "2026-10-14.5",
        runId,
        evaluationId: null,
      },
    });
    await expect(
      mergeReviewedProductPair(kernelCtx(ctx), {
        ...command,
        assessmentId: weak.id,
      }),
    ).rejects.toThrow(/obsolete/);
    expect(await getProductMatchQueue(ctx.db, {})).toMatchObject({ items: [] });
    await getDb(ctx.db)
      .update(product)
      .set({ model: "SYNTH-OTHER" })
      .where(eq(product.id, ids[1]!));
    const current = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort,
    });
    expect(current.pairs[0]).toMatchObject({
      actionable: false,
      conflict: true,
      producer: {
        kind: "model",
        revision: PRODUCT_IDENTITY_FEATURE.promptVersion,
      },
    });
    await publishProductIdentity(ctx.db, current);
    const queue = await getProductMatchQueue(ctx.db, {});
    expect(queue.items).toHaveLength(1);
    expect(queue.items[0]?.assessmentId).not.toBe(weak.id);
    expect(queue.items[0]?.identityConflict).toBe(true);
    await expect(
      mergeReviewedProductPair(kernelCtx(ctx), {
        ...command,
        assessmentId: queue.items[0]!.assessmentId,
      }),
    ).rejects.toThrow(/conflict/);
  });
  it("keeps raw SKUs and matching model text as recommendations", async () => {
    const { ids, runId, decisionPort } = await acceptedIdentityPair(
      [
        "Synthetic slim-fit blue medium shirt, pack of 2",
        "Synthetic relaxed-fit blue medium shirt, pack of 2",
      ],
      "SYNTH-VARIANT-2",
    );
    const result = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort,
    });
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      actionable: false,
      conflict: false,
    });
  });
  it("refuses a prior Product identity policy publication after activation advances", async () => {
    const { ids, runId } = await acceptedIdentityPair(
      [
        "Synthetic prior blue medium shirt, pack of 2",
        "Synthetic next red medium shirt, pack of 2",
      ],
      "SYNTH-STYLE",
    );
    const manifest = await compiledRefreshManifest();
    const feature = PRODUCT_IDENTITY_FEATURE.feature;
    const active = await activateAiRefresh(ctx.db, "synthetic-prior-policy", {
      enabled: true,
      manifest: {
        ...manifest,
        [feature]: { ...manifest[feature]!, promptVersion: "2026-10-14.5" },
      },
    });
    const evaluation = await requestProductIdentityPair(
      ctx.db,
      [ids[0]!, ids[1]!],
      runId,
      {
        dependencies: [{ feature, ...active.manifest[feature]! }],
        inputFingerprint: "synthetic-prepared",
        optionFingerprint: "synthetic-options",
        model: "typesafe/jev",
      },
    );
    expect(
      preparedProductIdentityPair.parse(evaluation.snapshot).conflict,
    ).toBe(false);
    await getDb(ctx.db)
      .update(aiEvaluation)
      .set({
        snapshot: {
          ...preparedProductIdentityPair.parse(evaluation.snapshot),
          conflict: false,
        },
      })
      .where(eq(aiEvaluation.id, evaluation.id));
    const claimed = await withJobFixtureExecution(
      ctx.db,
      {
        key: `ai-evaluation:${evaluation.id}`,
        kind: "ai.evaluation",
        input: { evaluationId: evaluation.id },
      },
      () => claimAiEvaluation(ctx.db, evaluation.id),
    );
    await activateAiRefresh(ctx.db, "synthetic-current-policy", {
      enabled: true,
      manifest,
    });
    await expect(
      withJobFixtureExecution(
        ctx.db,
        {
          key: `ai-evaluation:${evaluation.id}`,
          kind: "ai.evaluation",
          input: { evaluationId: evaluation.id },
        },
        () =>
          publishAiEvaluation(
            ctx.db,
            evaluation.id,
            claimed!.attemptToken!,
            async (transactionDb) => {
              await publishProductIdentity(transactionDb, { pairs: [] });
              return {};
            },
          ),
      ),
    ).rejects.toThrow(/obsolete/);
    expect(await getDb(ctx.db).select().from(assessment)).toHaveLength(0);
  });
  it("publishes exact rule evidence through an activated catalog pass while the model is unavailable", async () => {
    const { ids } = await acceptedIdentityPair([
      "Synthetic first blue medium shirt, pack of 2",
      "Synthetic second blue medium shirt, pack of 2",
    ]);
    const ports = {
      context: kernelCtx(ctx),
      productIdentityPorts: {
        decisionPort: async () => {
          throw new Error("Synthetic unavailable model");
        },
      },
    };
    expect((await discoverAiRefresh(ctx.db, ports)).runs).toEqual([]);
    const active = await activateAiRefresh(
      ctx.db,
      "synthetic:activated-rule-pass",
      { enabled: true },
    );
    await saveAiDiscoveryCursor(ctx.db, {
      revision: active.revision,
      field: null,
      fieldDone: true,
      email: null,
      emailDone: true,
      product: null,
      productDone: false,
    });
    await discoverAiRefresh(ctx.db, ports);
    const targets = (await getDb(ctx.db).select().from(aiEvaluation)).filter(
      (row) => row.target.kind === "product",
    );
    expect(targets).toHaveLength(2);
    for (const target of targets)
      expect(
        await withJobFixtureExecution(
          ctx.db,
          {
            key: `ai-evaluation:${target.id}`,
            kind: "ai.evaluation",
            input: { evaluationId: target.id },
          },
          () => executeAiRefreshTarget(ctx.db, target.id, ports),
        ),
      ).toBe(true);
    const pairs = await listProductMatchRows(ctx.db);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ actionable: true, conflict: false });
    expect(new Set([pairs[0]!.productAId, pairs[0]!.productBId])).toEqual(
      new Set(ids),
    );
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
      issuer: true,
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
    ).rejects.toThrow(/stale|changed|conflict/);
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
    const first = await requestProductIdentityPair(
      ctx.db,
      [ids[0]!, ids[1]!],
      runs[0]!,
      provenance,
    );
    const other = await requestProductIdentityPair(
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
  it("does not retrieve candidates from shared research URLs or claimed variants", async () => {
    const a = await productFixture(ctx, "Synthetic catalog alpha", {
      brandId: await findOrCreateVendor(ctx.db, "Synthetic Alpha"),
      model: null,
    });
    const b = await productFixture(ctx, "Synthetic catalog omega", {
      brandId: await findOrCreateVendor(ctx.db, "Synthetic Omega"),
      model: null,
    });
    const ids = await Promise.all(
      [a, b].map((row) => recordId(ctx.db, row.id, "product")),
    );
    await getDb(ctx.db)
      .update(product)
      .set({
        notes:
          "https://catalog.example.test/shared-family Selected variant: blue medium",
      })
      .where(inArray(product.id, ids));
    expect(
      (await retrieveProductIdentityCandidates(ctx.db, ids[0]!)).candidates,
    ).not.toContain(ids[1]);
    expect(
      await prepareProductIdentityPair(ctx.db, [ids[0]!, ids[1]!]),
    ).toMatchObject({
      exact: false,
      verification: "unknown",
      variantEvidence: null,
    });
  });
  it("honors a nonexact model distinct verdict without suppressing a revised assessment", async () => {
    const { ids, runId } = await acceptedIdentityPair(
      [
        "Synthetic blue small shirt, pack of 2",
        "Synthetic red large shirt, pack of 2",
      ],
      "SYNTH-SHARED-STYLE",
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
    await publishProductIdentity(ctx.db, result);
    expect(
      (
        await getProductMatchQueue(ctx.db, {
          productId: parseShortcodeFor(
            "product",
            (
              await getDb(ctx.db)
                .select()
                .from(product)
                .where(eq(product.id, ids[0]!))
            )[0]!.shortcode,
          ),
        })
      ).items,
    ).toEqual([]);
    const [state] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.family, "product_pair"));
    expect(state).toMatchObject({ status: "resolved", suppression: null });
    await getDb(ctx.db)
      .update(product)
      .set({ name: "Synthetic revised blue medium shirt" })
      .where(eq(product.id, ids[0]!));
    const revised = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
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
    await publishProductIdentity(ctx.db, revised);
    expect(await listProductMatchRows(ctx.db)).toHaveLength(1);
  });
  it("keeps research notes and a positive model verdict as a recommendation", async () => {
    const a = await productFixture(ctx, "Synthetic partial A"),
      b = await productFixture(ctx, "Synthetic partial B");
    const ids = await Promise.all(
      [a, b].map((row) => recordId(ctx.db, row.id, "product")),
    );
    await getDb(ctx.db)
      .update(product)
      .set({
        notes: "Blue style family https://catalog.example.test/style/family",
      })
      .where(inArray(product.id, ids));
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
