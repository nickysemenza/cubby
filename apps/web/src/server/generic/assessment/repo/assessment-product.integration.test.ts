import { parseEntityId, parseShortcodeFor } from "@cubby/schemas/identifiers";
import { acceptedSourceOrder } from "@cubby/schemas/purchase-import";
import { SHORTCODE_CHARS } from "@cubby/shared";
import { sha256Hex } from "@cubby/shared/sha256";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import type { DecisionPort } from "~/server/ai/decision-model";
import { PRODUCT_IDENTITY_FEATURE } from "~/server/ai/features";
import { enqueueProductIdentityPair } from "~/server/ai/product-identity";
import {
  evaluateProductIdentity,
  publishProductIdentity,
  productIdentitySnapshot,
  prepareProductIdentityPair,
  preparedProductIdentityPair,
  retrieveProductIdentityCandidates,
} from "~/server/ai/product-identity";
import { compiledRefreshManifest } from "~/server/ai/refresh-policy";
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
  entitySource,
  importSourceClaim,
  importSourceOrder,
  importSourceProduct,
  externalSource,
  feedback,
  product,
  inventoryEntry,
} from "~/server/db/schema";
import { createInventoryEntry } from "~/server/domains/inventory/repo/crud";
import { mergeProducts } from "~/server/domains/product/repo/merge";
import {
  listProductMatchRows,
  publishProductPair,
} from "~/server/domains/product/repo/product-match-candidate";
import {
  groundedVariantEvidence,
  variantLiteral,
} from "~/server/domains/product/repo/product-variant-evidence";
import { getProductMatchQueue } from "~/server/domains/product/service/product-match.service";
import {
  discoverAiRefresh,
  executeAiRefreshTarget,
} from "~/server/domains/run/service/ai-refresh";
import { ensureRun } from "~/server/domains/run/service/ensure-run";
import {
  kernelCtx,
  productFixture,
  recordId,
} from "~/server/domains/run/service/suggestion-sweep.fixtures";
import { executeEntity } from "~/server/entity-kernel";
import { canonicalJson } from "~/server/entity-kernel/repo/entity-source";
import { mergeReviewedProductPair } from "~/server/generic/assessment/repo/assessment-product";
import { reviewAssessment } from "~/server/generic/assessment/repo/assessment-review";
import { findDuplicateProductIdentities } from "~/server/generic/problems/repo/detectors-product";
import { insertWithShortcode } from "~/server/generic/shortcode/repo/shortcode-utils";
import { createMcpServer } from "~/server/mcp/server";
import { callMcpTool } from "~/server/testing/mcp-test-utils";
import {
  createLocationFixture,
  makeLocationInput,
} from "~/server/testing/repo.fixtures";

// The external model seam selects explicit fixture facts, never a runtime vocabulary classifier.
const variantPort =
  (
    facts: Record<
      string,
      { color: string | null; size: string | null; pack: string | null }
    >,
  ): DecisionPort =>
  async (request) => {
    const subject = z
      .object({
        phase: z.string(),
        dimension: z.enum(["color", "size", "pack"]),
        name: z.string().optional(),
        first: variantLiteral.optional(),
        second: variantLiteral.optional(),
      })
      .safeParse(JSON.parse(request.state));
    const entries = Object.entries(request.questions.selection.criteria);
    let choice = "c0";
    if (subject.success && subject.data.phase === "variant_literal") {
      const wanted = facts[subject.data.name ?? ""]?.[subject.data.dimension];
      choice =
        entries.find(([, value]) => {
          const span = variantLiteral.safeParse(
            JSON.parse(value.startsWith("{") ? value : "null"),
          );
          return wanted && span.success && span.data.value === wanted;
        })?.[0] ?? "none";
    } else if (subject.success && subject.data.phase === "variant_relation") {
      choice =
        subject.data.first?.value === subject.data.second?.value ? "c0" : "c1";
    }
    return {
      answers: {
        selection: {
          type: "choice",
          choice,
          confidence: 0.99,
          probabilities: Object.fromEntries(
            entries.map(([key]) => [
              key,
              key === choice ? 0.99 : 0.01 / Math.max(1, entries.length - 1),
            ]),
          ),
        },
      },
    };
  };

// Failure modes: an unavailable model hides exact rule evidence; discovery
// direction duplicates the same immutable pair; stale identity permits merge;
// merging rewrites the original subject instead of retiring current actions;
// a new scan resurfaces an unchanged pair after a member's wrong verdict.
// Shared exact claims must not merge Source-confirmed conflicting variants;
// an accepted raw style SKU is association evidence, not variant granularity.
// Agent proposals must not erase verified conflicts; completed old policies
// must not authorize an unchanged-fingerprint merge after rule activation.
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
          manufacturer: "Synthetic queue maker",
        };
      });
      await getDb(ctx.db).insert(product).values(products);
      const anchor = products[0]!;
      const predictions = products.slice(1).map((row, index) => ({
        id: `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        publicationKey: `synthetic:queue-limit:${index}`,
        family: "product_pair" as const,
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
      const queue = await getProductMatchQueue(ctx.db, {});
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
  const boundVariantPair = async (
    names: readonly [string, string],
    sku?: string,
    facts?: readonly [
      { color: string | null; size: string | null; pack: string | null },
      { color: string | null; size: string | null; pack: string | null },
    ],
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
    await getDb(ctx.db).insert(externalSource).values({
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
    return {
      products,
      ids,
      runId,
      decisionPort: variantPort(
        Object.fromEntries(
          names.map((name, index) => [
            name,
            facts?.[index] ?? { color: null, size: null, pack: null },
          ]),
        ),
      ),
    };
  };
  it("keeps an agent propose_match conflict through the queue and actual merge", async () => {
    const { products, ids, decisionPort } = await boundVariantPair(
      [
        "Synthetic blue medium shirt, pack of 2",
        "Synthetic red medium shirt, pack of 2",
      ],
      undefined,
      [
        { color: "blue", size: "medium", pack: "2" },
        { color: "red", size: "medium", pack: "2" },
      ],
    );
    const location = await createLocationFixture(
      ctx.db,
      makeLocationInput({ name: "Synthetic conflict shelf" }),
      ctx.actor,
    );
    await createInventoryEntry(
      ctx.db,
      {
        productId: ids[0]!,
        locationId: location.entityId,
        amount: { value: 1, unit: "each" },
      },
      ctx.actor,
    );
    const ports = {
      context: kernelCtx(ctx),
      productIdentityPorts: { decisionPort },
    };
    const active = await activateAiRefresh(
      ctx.db,
      "synthetic:grounded-durable-pass",
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
      expect(await executeAiRefreshTarget(ctx.db, target.id, ports)).toBe(true);
    const original = (await getDb(ctx.db).select().from(assessment))[0]!;
    const proposal = await callMcpTool(
      createMcpServer(),
      "product_enrichment",
      {
        action: "propose_match",
        productIds: products.map((row) => row.id),
        evidence: "Synthetic agent sees both sources",
        sourceUrls: ["https://www.amazon.com/dp/B000000001"],
      },
      { db: ctx.db },
    );
    expect(proposal.isError).not.toBe(true);
    const queue = await getProductMatchQueue(ctx.db, {});
    const candidate = queue.items[0]!;
    await expect(
      mergeReviewedProductPair(kernelCtx(ctx), {
        keepId: products[0]!.id,
        mergeId: products[1]!.id,
        assessmentId: candidate.assessmentId,
        expectedFingerprint: candidate.fingerprint!,
      }),
    ).rejects.toThrow(/conflict/);
    expect(candidate.identityConflict).toBe(true);
    expect(
      (await getDb(ctx.db).select().from(inventoryEntry))[0]?.amountValue,
    ).toBe(1);
    expect(
      (await getDb(ctx.db).select().from(assessment)).find(
        (row) => row.id === original.id,
      )?.subject,
    ).toEqual(original.subject);
  });
  // A stale grounded conflict must fence every later publisher, including exact outage fallback and agents.
  it("retains pending conflict verification after a quote edit until fresh grounded evidence clears it", async () => {
    const names = [
      "Synthetic blue medium shirt, pack of 2",
      "Synthetic red medium shirt, pack of 2",
    ] as const;
    const { products, ids, runId, decisionPort } = await boundVariantPair(
      names,
      undefined,
      [
        { color: "blue", size: "medium", pack: "2" },
        { color: "red", size: "medium", pack: "2" },
      ],
    );
    const original = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort,
      model: "typesafe/jev",
    });
    expect(original.pairs[0]?.conflict).toBe(true);
    const proof = groundedVariantEvidence.parse(
      z
        .object({ variantEvidence: groundedVariantEvidence })
        .parse(original.pairs[0]!.signals).variantEvidence,
    );
    const color = proof.dimensions.find((row) => row.dimension === "color")!;
    expect(color.first?.sourceId).not.toBe(color.second?.sourceId);
    expect(proof.producer).toMatchObject({
      kind: "model",
      model: "typesafe/jev",
      runId,
    });
    for (const corrupt of [
      { ...color.first!, start: color.first!.start + 1 },
      { ...color.first!, sourceId: color.second!.sourceId },
      { ...color.first!, productId: color.second!.productId },
      { ...color.first!, valueFingerprint: "invalid-current-value" },
    ]) {
      const bad = {
        ...proof,
        dimensions: proof.dimensions.map((row) =>
          row.dimension === "color" ? { ...row, first: corrupt } : row,
        ),
      };
      expect(
        await prepareProductIdentityPair(ctx.db, [ids[0]!, ids[1]!], {
          variantEvidence: z.json().parse(bad),
        }),
      ).toMatchObject({ conflict: false, verification: "unknown" });
    }
    await publishProductIdentity(ctx.db, original);
    // The Source now supports a changed current name, while the earlier literal remains immutable.
    const nextName = "Synthetic second blue medium shirt, pack of 2";
    await getDb(ctx.db)
      .update(product)
      .set({ name: nextName })
      .where(eq(product.id, ids[1]!));
    const sources = await getDb(ctx.db)
      .select()
      .from(entitySource)
      .where(eq(entitySource.entityId, ids[1]!));
    const source = sources.find((row) => row.fieldPath === "name")!;
    await getDb(ctx.db)
      .update(entitySource)
      .set({
        quote: nextName,
        valueFingerprint: await sha256Hex(canonicalJson(nextName)),
      })
      .where(eq(entitySource.id, source.id));
    const staleQueue = await getProductMatchQueue(ctx.db, {});
    expect(staleQueue.items).toEqual([]);
    const partial = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort: variantPort({
        [names[0]]: { color: null, size: "medium", pack: "2" },
        [nextName]: { color: null, size: "medium", pack: "2" },
      }),
    });
    expect(partial.pairs[0]).toMatchObject({
      conflict: false,
      signals: { verification: "pending_verification" },
    });
    await publishProductIdentity(ctx.db, partial);
    const outage = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort: async () => {
        throw new Error("Synthetic model outage");
      },
    });
    expect(outage.pairs[0]).toMatchObject({
      conflict: false,
      signals: { verification: "pending_verification" },
    });
    await publishProductIdentity(ctx.db, outage);
    const proposal = await callMcpTool(
      createMcpServer(),
      "product_enrichment",
      {
        action: "propose_match",
        productIds: products.map((row) => row.id),
        evidence: "Synthetic exact claim after source edit",
        sourceUrls: [],
      },
      { db: ctx.db },
    );
    expect(proposal.isError).not.toBe(true);
    const candidate = (await getProductMatchQueue(ctx.db, {})).items[0]!;
    expect(candidate).toMatchObject({
      identityConflict: false,
      signals: ["Variant verification pending"],
    });
    await expect(
      mergeReviewedProductPair(kernelCtx(ctx), {
        keepId: products[0]!.id,
        mergeId: products[1]!.id,
        assessmentId: candidate.assessmentId,
        expectedFingerprint: candidate.fingerprint!,
      }),
    ).rejects.toThrow(/verification/);
    const fresh = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort: variantPort({
        [names[0]]: { color: "blue", size: "medium", pack: "2" },
        [nextName]: { color: "blue", size: "medium", pack: "2" },
      }),
    });
    expect(fresh.pairs[0]).toMatchObject({
      conflict: false,
      signals: { verification: "current" },
    });
    await publishProductIdentity(ctx.db, fresh);
    const ready = (await getProductMatchQueue(ctx.db, {})).items[0]!;
    await mergeReviewedProductPair(kernelCtx(ctx), {
      keepId: products[0]!.id,
      mergeId: products[1]!.id,
      assessmentId: ready.assessmentId,
      expectedFingerprint: ready.fingerprint!,
    });
    expect(
      (await getDb(ctx.db).select().from(assessment)).some(
        (row) =>
          z
            .object({ conflict: z.boolean().optional() })
            .passthrough()
            .parse(row.evidence).conflict,
      ),
    ).toBe(true);
  });
  it("carries unresolved grounded conflict through actual Product merges", async () => {
    const { products, ids, runId, decisionPort } = await boundVariantPair(
      [
        "Synthetic blue medium shirt, pack of 2",
        "Synthetic red medium shirt, pack of 2",
      ],
      undefined,
      [
        { color: "blue", size: "medium", pack: "2" },
        { color: "red", size: "medium", pack: "2" },
      ],
    );
    await publishProductIdentity(
      ctx.db,
      await evaluateProductIdentity(ctx.db, ids[0]!, runId, { decisionPort }),
    );
    const [historical] = await getDb(ctx.db).select().from(assessment);
    let previous = products[0]!;
    for (const name of [
      "Synthetic first replacement",
      "Synthetic second replacement",
    ]) {
      const keeper = await productFixture(ctx, name);
      const keeperId = await recordId(ctx.db, keeper.id, "product");
      const previousId = await recordId(ctx.db, previous.id, "product");
      const prepared = await prepareProductIdentityPair(ctx.db, [
        keeperId,
        previousId,
      ]);
      const candidate = await publishProductPair(ctx.db, {
        productIds: [keeperId, previousId],
        source: "agent",
        evidence: "Synthetic reviewed same item",
        sourceUrls: [],
        fingerprint: prepared!.fingerprint,
      });
      await mergeReviewedProductPair(kernelCtx(ctx), {
        keepId: keeper.id,
        mergeId: previous.id,
        assessmentId: candidate.id,
        expectedFingerprint: candidate.fingerprint!,
      });
      const remaining = await prepareProductIdentityPair(ctx.db, [
        keeperId,
        ids[1]!,
      ]);
      expect(remaining).toMatchObject({
        conflict: false,
        verification: "pending_verification",
      });
      const proposal = await publishProductPair(ctx.db, {
        productIds: [keeperId, ids[1]!],
        source: "agent",
        evidence: "Synthetic post-merge proposal",
        sourceUrls: [],
        fingerprint: remaining!.fingerprint,
      });
      await expect(
        mergeReviewedProductPair(kernelCtx(ctx), {
          keepId: keeper.id,
          mergeId: products[1]!.id,
          assessmentId: proposal.id,
          expectedFingerprint: proposal.fingerprint!,
        }),
      ).rejects.toThrow(/verification/);
      previous = keeper;
    }
    expect(
      (
        await getDb(ctx.db)
          .select()
          .from(assessment)
          .where(eq(assessment.id, historical!.id))
      )[0]?.subject,
    ).toEqual(historical!.subject);
  });
  // Every Product merge entry point must fence current or unresolved conflicts, including loser–loser pairs.
  it.each(
    [false, true].flatMap((multiway) =>
      ["current", "stale", "excluded"].map((evidence) => ({
        multiway,
        evidence,
      })),
    ),
  )(
    "refuses a generic merge atomically across every combined pair: %j",
    async ({ multiway, evidence }) => {
      const { products, ids, runId, decisionPort } = await boundVariantPair(
        [
          "Synthetic blue medium shirt, pack of 2",
          "Synthetic red medium shirt, pack of 2",
        ],
        undefined,
        [
          { color: "blue", size: "medium", pack: "2" },
          { color: "red", size: "medium", pack: "2" },
        ],
      );
      await publishProductIdentity(
        ctx.db,
        await evaluateProductIdentity(ctx.db, ids[0]!, runId, { decisionPort }),
      );
      const neutral = await productFixture(
        ctx,
        "Synthetic neutral merge keeper",
      );
      const neutralId = await recordId(ctx.db, neutral.id, "product");
      const location = await createLocationFixture(
        ctx.db,
        makeLocationInput({ name: "Synthetic guarded merge shelf" }),
        ctx.actor,
      );
      for (const [index, id] of ids.entries())
        await createInventoryEntry(
          ctx.db,
          {
            productId: id,
            locationId: location.entityId,
            amount: { value: index + 2, unit: "each" },
          },
          ctx.actor,
        );
      if (evidence === "stale") {
        const sources = await getDb(ctx.db)
          .select()
          .from(entitySource)
          .where(eq(entitySource.entityId, ids[1]!));
        const source = sources.find((row) => row.fieldPath === "name")!;
        await getDb(ctx.db)
          .update(entitySource)
          .set({ quote: "Synthetic edited source without variant facts" })
          .where(eq(entitySource.id, source.id));
      }
      if (evidence === "excluded")
        await getDb(ctx.db)
          .update(product)
          .set({ name: "Misc" })
          .where(eq(product.id, ids[1]!));
      const neutralPairs = await Promise.all(
        ids.map((id) => prepareProductIdentityPair(ctx.db, [neutralId, id])),
      );
      expect(
        neutralPairs.every(
          (pair) =>
            pair === null ||
            (!pair.conflict && pair.verification !== "pending_verification"),
        ),
      ).toBe(true);
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
          getDb(ctx.db).select().from(entitySource).orderBy(entitySource.id),
          getDb(ctx.db)
            .select()
            .from(importSourceProduct)
            .orderBy(importSourceProduct.id),
        ]);
      const before = await readPreserved();
      const input = {
        keepId: multiway ? neutral.id : products[0]!.id,
        mergeIds: multiway ? products.map((row) => row.id) : [products[1]!.id],
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
  it("keeps model conflict history pending until current Source-bound model values agree", async () => {
    const { products, ids, runId, decisionPort } = await boundVariantPair([
      "Synthetic model item A",
      "Synthetic model item B",
    ]);
    const rows = await getDb(ctx.db)
      .select()
      .from(entitySource)
      .where(eq(entitySource.entityId, ids[1]!));
    const source = rows.find((row) => row.fieldPath === "model")!;
    await getDb(ctx.db)
      .update(product)
      .set({ model: "SYNTH-OTHER" })
      .where(eq(product.id, ids[1]!));
    await getDb(ctx.db)
      .update(entitySource)
      .set({
        quote: "SYNTH-OTHER",
        valueFingerprint: await sha256Hex(canonicalJson("SYNTH-OTHER")),
      })
      .where(eq(entitySource.id, source.id));
    const conflict = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort,
    });
    expect(conflict.pairs[0]).toMatchObject({ conflict: true });
    await publishProductIdentity(ctx.db, conflict);
    await getDb(ctx.db)
      .delete(entitySource)
      .where(eq(entitySource.id, source.id));
    const outagePort = async () => {
      throw new Error("Synthetic model outage");
    };
    const missing = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort: outagePort,
    });
    expect(missing.pairs[0]).toMatchObject({
      conflict: false,
      signals: { verification: "pending_verification" },
    });
    await publishProductIdentity(ctx.db, missing);
    const blocked = (await getProductMatchQueue(ctx.db, {})).items[0]!;
    await expect(
      mergeReviewedProductPair(kernelCtx(ctx), {
        keepId: products[0]!.id,
        mergeId: products[1]!.id,
        assessmentId: blocked.assessmentId,
        expectedFingerprint: blocked.fingerprint!,
      }),
    ).rejects.toThrow(/verification/);
    await getDb(ctx.db)
      .update(product)
      .set({ model: "SYNTH-STYLE" })
      .where(eq(product.id, ids[1]!));
    await getDb(ctx.db)
      .insert(entitySource)
      .values({
        entityId: ids[1]!,
        entityKind: "product",
        fieldPath: "model",
        quote: "SYNTH-STYLE",
        valueFingerprint: await sha256Hex(canonicalJson("SYNTH-STYLE")),
        url: "https://catalog.example.test/current-model",
        userId: ctx.actor.userId,
        channel: "web",
      });
    const cleared = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort: outagePort,
    });
    expect(cleared.pairs[0]).toMatchObject({ conflict: false });
    expect(
      z.object({ verification: z.string() }).parse(cleared.pairs[0]!.signals)
        .verification,
    ).not.toBe("pending_verification");
    await publishProductIdentity(ctx.db, cleared);
    const ready = (await getProductMatchQueue(ctx.db, {})).items[0]!;
    await mergeReviewedProductPair(kernelCtx(ctx), {
      keepId: products[0]!.id,
      mergeId: products[1]!.id,
      assessmentId: ready.assessmentId,
      expectedFingerprint: ready.fingerprint!,
    });
  });
  it("refuses a completed prior-rule admission with unchanged evidence", async () => {
    const { products, ids, runId, decisionPort } = await boundVariantPair(
      [
        "Synthetic prior blue medium shirt, pack of 2",
        "Synthetic next red medium shirt, pack of 2",
      ],
      "SYNTH-STYLE",
      [
        { color: "blue", size: "medium", pack: "2" },
        { color: "red", size: "medium", pack: "2" },
      ],
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
  it.each([
    [
      "Synthetic blue medium shirt, pack of 2",
      "Synthetic red medium shirt, pack of 2",
      { color: "blue", size: "medium", pack: "2" },
      { color: "red", size: "medium", pack: "2" },
    ],
    [
      "Synthetic blue small shirt, pack of 2",
      "Synthetic blue large shirt, pack of 2",
      { color: "blue", size: "small", pack: "2" },
      { color: "blue", size: "large", pack: "2" },
    ],
    [
      "Synthetic blue medium shirt, pack of 2",
      "Synthetic blue medium shirt, pack of 4",
      { color: "blue", size: "medium", pack: "2" },
      { color: "blue", size: "medium", pack: "4" },
    ],
  ] as const)(
    "refuses an exact claim with verified conflicting variants: %s / %s",
    async (first, second, firstFacts, secondFacts) => {
      const { products, ids, runId, decisionPort } = await boundVariantPair(
        [first, second],
        undefined,
        [firstFacts, secondFacts],
      );
      const result = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
        decisionPort,
      });
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
    const { products, ids, runId, decisionPort } = await boundVariantPair(
      [
        "Synthetic blue small shirt, pack of 2",
        "Synthetic blue large shirt, pack of 2",
      ],
      "SYNTH-STYLE",
      [
        { color: "blue", size: "small", pack: "2" },
        { color: "blue", size: "large", pack: "2" },
      ],
    );
    const result = await evaluateProductIdentity(ctx.db, ids[0]!, runId, {
      decisionPort,
    });
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({
      actionable: false,
      conflict: true,
    });
    await publishProductIdentity(ctx.db, result);
    const [state] = await getDb(ctx.db)
      .select()
      .from(assessmentState)
      .where(eq(assessmentState.family, "product_pair"));
    await expect(
      mergeReviewedProductPair(kernelCtx(ctx), {
        keepId: products[0]!.id,
        mergeId: products[1]!.id,
        assessmentId: state!.id,
        expectedFingerprint: state!.fingerprint!,
      }),
    ).rejects.toThrow(/conflict/);
  });
  it("keeps raw SKUs uncertain despite matching three dimensions and different verified fits", async () => {
    const { ids, runId, decisionPort } = await boundVariantPair(
      [
        "Synthetic slim-fit blue medium shirt, pack of 2",
        "Synthetic relaxed-fit blue medium shirt, pack of 2",
      ],
      "SYNTH-VARIANT-2",
      [
        { color: "blue", size: "medium", pack: "2" },
        { color: "blue", size: "medium", pack: "2" },
      ],
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
    const { ids, runId } = await boundVariantPair(
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
    const evaluation = await enqueueProductIdentityPair(
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
    const claimed = await claimAiEvaluation(ctx.db, evaluation.id);
    await activateAiRefresh(ctx.db, "synthetic-current-policy", {
      enabled: true,
      manifest,
    });
    await expect(
      publishAiEvaluation(
        ctx.db,
        evaluation.id,
        claimed!.attemptToken!,
        async (transactionDb) => {
          await publishProductIdentity(transactionDb, { pairs: [] });
          return {};
        },
      ),
    ).rejects.toThrow(/obsolete/);
    expect(await getDb(ctx.db).select().from(assessment)).toHaveLength(0);
  });
  it("publishes exact rule evidence through an activated catalog pass while the model is unavailable", async () => {
    const { ids } = await boundVariantPair([
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
    expect(await discoverAiRefresh(ctx.db, ports)).toEqual([]);
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
      expect(await executeAiRefreshTarget(ctx.db, target.id, ports)).toBe(true);
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
  it.each(["URL", "selectedVariant"])(
    "retrieves Source %s candidates without names, models, exact claims or embeddings",
    async (clue) => {
      const a = await productFixture(ctx, "Synthetic catalog alpha", {
          manufacturer: "Synthetic Alpha",
          model: null,
        }),
        b = await productFixture(ctx, "Synthetic catalog omega", {
          manufacturer: "Synthetic Omega",
          model: null,
        });
      const ids = await Promise.all(
        [a, b].map((row) => recordId(ctx.db, row.id, "product")),
      );
      await getDb(ctx.db)
        .insert(entitySource)
        .values(
          ids.map((id, index) => ({
            entityId: id,
            entityKind: "product" as const,
            fieldPath: "name",
            valueFingerprint: "synthetic-retained-ranking",
            selectedVariant:
              clue === "selectedVariant"
                ? "Synthetic edition · blue · medium"
                : index
                  ? "red"
                  : "blue",
            url:
              clue === "URL"
                ? "https://catalog.example.test/shared-family"
                : `https://catalog.example.test/retained-${index}`,
            quote: "Retained family page",
            userId: ctx.actor.userId,
            channel: "web" as const,
          })),
        );
      expect(
        await retrieveProductIdentityCandidates(ctx.db, ids[0]!),
      ).toContain(ids[1]);
      expect(
        await prepareProductIdentityPair(ctx.db, [ids[0]!, ids[1]!]),
      ).toMatchObject({ exact: false, conflict: false });
    },
  );
  it("honors a nonexact model distinct verdict without suppressing a revised assessment", async () => {
    const { ids, runId } = await boundVariantPair(
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
