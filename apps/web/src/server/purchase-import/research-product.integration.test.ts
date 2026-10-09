import { parseShortcodeFor } from "@cubby/schemas/identifiers";
import type { ProductCreateInput } from "@cubby/schemas/product";
import { researchWorkResolve } from "@cubby/schemas/research-tools";
import { UNSPECIFIED_MANUFACTURER } from "@cubby/shared/constants";
import { sha256Hex } from "@cubby/shared/sha256";
import { fromPartial } from "@total-typescript/shoehorn";
import { and, eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { setCfEnv } from "~/server/cf-env";
import {
  entityAttachment,
  image,
  entityExternalId,
  externalSource,
  productMatchCandidate,
  product,
  productCategory,
  ledgerParty,
  runEvidence,
  runFactEvidence,
  runOperation,
  runFinding,
  runTarget,
} from "~/server/db/schema";
import {
  getDb,
  notDeleted,
  withTransaction,
} from "~/server/repo/database-helpers";
import { runReport } from "~/server/repo/entity-report/run";
import { findOrCreateIngredient } from "~/server/repo/ingredient/crud";
import { resolveProductIdentifierSource } from "~/server/repo/product-identifier-source";
import { updateProduct } from "~/server/repo/product/crud";
import { getRecipeTotalsState } from "~/server/repo/recipe/totals";
import {
  createProductFixture,
  createImageFixture,
  createRecipeFixture,
  ingredientRef,
  makeRecipeInput,
  insertEntityAttachments,
  makeProductInput,
} from "~/server/repo/repo.fixtures";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { createTestRequestContext } from "~/server/testing/request-context";

import { productionBrowserEvidenceStorage } from "./browser-results";
import { resolveRunFinding } from "./findings";
import { attachOrderLineThumbnails } from "./line-thumbnails";
import { productEnrichmentTarget } from "./product-enrichment-target";
import type { ResearchEvidenceReader } from "./research-evidence";
import { retainResearchObservation } from "./research-observations";
import { resolveProductResearch } from "./research-product";
import type { ResearchAssessor } from "./research-support";
import { loadRunDetail } from "./run-service";

// Write-boundary regressions: unrelated observations, wrong variants, populated
// contradictions, matching-value provenance, replay and late settled writes;
// supported corrections disappear from review or overwrite a later edit;
// catalog promotion displaces an explicit member cover or never replaces a
// known provisional order-line thumbnail; concurrent finding approval must
// not block a Product-holder's owner FK, and Ingredient corrections invalidate
// recipes using both the previous and replacement Ingredient.
describe("supported Product research writes", () => {
  const ctx = withTestDb();
  const support = {
    observation: "Example Works Q-17, small",
    reasoning: "The ordered small variant matches this selected variant.",
    selectedVariant: {
      identity: "Q-17 small",
      attributes: { size: "small" },
      reasoning: "The source distinguishes the small and large variants.",
    },
  };
  const retainedText = "Example Works Q-17, small; retailer SKU SMALL-17";
  async function fixture(
    manufacturer = "Example Works",
    fields: Partial<
      Pick<
        ProductCreateInput,
        | "name"
        | "categoryId"
        | "ingredientId"
        | "growsPlantId"
        | "price"
        | "unitMappings"
      >
    > = {},
    sourceText = retainedText,
  ) {
    const entity = await createProductFixture(
      ctx.db,
      makeProductInput({
        name: "Example small device",
        manufacturer,
        model: "",
        ...fields,
      }),
      ctx.actor,
    );
    const [member] = await getDb(ctx.db)
      .select()
      .from(ledgerParty)
      .where(
        and(
          eq(ledgerParty.userId, ctx.actor.userId),
          eq(ledgerParty.kind, "member"),
          notDeleted(ledgerParty),
        ),
      )
      .limit(1);
    const party =
      member ??
      (await insertWithShortcode(ctx.db, "ledgerParty", {
        name: "Example research member",
        kind: "member",
        userId: ctx.actor.userId,
      }));
    const fingerprint = await productEnrichmentTarget(
      getDb(ctx.db),
      entity.entityId,
    );
    if (!fingerprint) throw new Error("Synthetic Product missing");
    const run = await insertWithShortcode(ctx.db, "run", {
      purpose: "product_enrichment",
      status: "running",
      trigger: "manual",
      ledgerPartyId: party.id,
      actorName: party.name,
      actorUserId: ctx.actor.userId,
      actorEmail: "research@example.test",
      actorLedgerPartyShortcode: party.shortcode,
      actorLedgerPartyName: party.name,
      actorLedgerPartyKind: "member",
      input: {
        kind: "product_research",
        instructionRevision: 1,
        products: [
          {
            productId: entity.entityId,
            contextFingerprint: fingerprint.fingerprint,
          },
        ],
      },
    });
    const [target] = await getDb(ctx.db)
      .insert(runTarget)
      .values({
        runId: run.id,
        entityKind: "product",
        entityId: entity.entityId,
        workKey: entity.entityId,
        targetFingerprint: fingerprint.fingerprint,
      })
      .returning();
    if (!target) throw new Error("Synthetic target missing");
    const [evidence] = await getDb(ctx.db)
      .insert(runEvidence)
      .values({
        runId: run.id,
        targetId: target.id,
        kind: "browser_capture",
        objectKey: `synthetic/${run.id}/selected-variant`,
        checksum: await sha256Hex(sourceText),
        mediaType: "text/html",
        sourceMetadata: {
          sourceURL: "https://shop.example.test/device?size=small",
          readableText: sourceText,
          variantMarkers: [{ name: "size", value: "small" }],
        },
      })
      .returning();
    if (!evidence) throw new Error("Synthetic evidence missing");
    const proposal = {
      workRef: target.id,
      status: "verified" as const,
      identity: { evidenceIds: [evidence.id], reasoning: support.reasoning },
      facts: [
        {
          evidenceId: evidence.id,
          fieldPath: "manufacturer",
          value: "Example Works",
          support,
        },
        { evidenceId: evidence.id, fieldPath: "model", value: "Q-17", support },
      ],
      detail: "Verified the ordered small device.",
    };
    const ports = {
      assess: async () => ({
        identityVerified: true,
        acceptedFacts: [0, 1],
        acceptedIdentifiers: [],
        acceptedImages: [],
        rejected: [],
      }),
      readEvidence: async () => sourceText,
    };
    return { entity, run, target, evidence, proposal, ports };
  }
  // Reference writes must use the ordinary food policy, preserve member values,
  // retain canonical matching-value proof, and never invent catalog records.
  it("applies the ordinary food rule to an unclassified Product with a supported Ingredient and proves only the accepted fact", async () => {
    const ingredient = await insertWithShortcode(ctx.db, "ingredient", {
      name: "Synthetic published rice Ingredient",
    });
    const f = await fixture(
      "Example Works",
      { name: "Synthetic unclassified rice bag", categoryId: null },
      "The selected purchased bag contains jasmine rice.",
    );
    const result = await resolveProductResearch(
      ctx.db,
      {
        runId: f.run.id,
        callId: "synthetic-unclassified-food-rule",
        proposal: {
          ...f.proposal,
          facts: [
            {
              evidenceId: f.evidence.id,
              fieldPath: "ingredientId",
              value: ingredient.shortcode,
              support: {
                observation: "contains jasmine rice",
                reasoning:
                  "The original ingredient statement identifies the existing catalog Ingredient for this selected bag.",
              },
            },
          ],
        },
      },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [0],
          acceptedIdentifiers: [],
          acceptedImages: [],
          rejected: [],
        }),
      },
    );
    expect([...result.changedFields].sort()).toEqual([
      "categoryId",
      "ingredientId",
    ]);
    expect(result.verifiedFields).toEqual(["ingredientId"]);
    const [saved] = await getDb(ctx.db)
      .select({
        ingredientId: product.ingredientId,
        feature: productCategory.feature,
      })
      .from(product)
      .leftJoin(productCategory, eq(productCategory.id, product.categoryId))
      .where(eq(product.id, f.entity.entityId));
    expect(saved).toEqual({ ingredientId: ingredient.id, feature: "food" });
    const proof = await getDb(ctx.db)
      .select()
      .from(runFactEvidence)
      .where(eq(runFactEvidence.targetId, f.target.id));
    expect(proof).toMatchObject([
      { fieldPath: "ingredientId", value: ingredient.id },
    ]);
    expect(proof).toHaveLength(1);
  });
  it("links a supported existing Ingredient while preserving inherited food classification and replay", async () => {
    const [food] = await getDb(ctx.db)
      .select({ id: productCategory.id })
      .from(productCategory)
      .where(
        and(eq(productCategory.feature, "food"), notDeleted(productCategory)),
      )
      .limit(1);
    if (!food) throw new Error("Synthetic food root missing");
    const rice = await insertWithShortcode(ctx.db, "productCategory", {
      name: "Example rice category",
      parentId: food.id,
    });
    const ingredient = await insertWithShortcode(ctx.db, "ingredient", {
      name: "Example jasmine rice ingredient",
    });
    const f = await fixture(
      "Example Works",
      { name: "Example jasmine rice bag", categoryId: rice.shortcode },
      "Example Works jasmine rice, small bag; ingredients: jasmine rice.",
    );
    const input = {
      runId: f.run.id,
      callId: crypto.randomUUID(),
      proposal: {
        ...f.proposal,
        facts: [
          {
            evidenceId: f.evidence.id,
            fieldPath: "ingredientId",
            value: ingredient.shortcode,
            support: {
              observation: "ingredients: jasmine rice",
              reasoning:
                "The retained ordered bag identifies this existing Ingredient.",
            },
          },
        ],
      },
    };
    const recomputed: string[][] = [];
    const ports = {
      ...f.ports,
      recomputeForIngredients: async (_db: typeof ctx.db, ids: string[]) => {
        recomputed.push(ids);
        return 0;
      },
      assess: async () => ({
        identityVerified: true,
        acceptedFacts: [0],
        acceptedIdentifiers: [],
        acceptedImages: [],
        rejected: [],
      }),
    };
    const result = await resolveProductResearch(ctx.db, input, ports);
    expect(result).toMatchObject({
      outcome: "researched_with_gaps",
      changedFields: ["ingredientId"],
      verifiedFields: ["ingredientId"],
      contradictions: [],
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(saved).toMatchObject({
      ingredientId: ingredient.id,
      categoryId: rice.id,
    });
    const proofs = await getDb(ctx.db)
      .select()
      .from(runFactEvidence)
      .where(eq(runFactEvidence.targetId, f.target.id));
    expect(proofs).toHaveLength(1);
    expect(proofs[0]).toMatchObject({
      fieldPath: "ingredientId",
      value: ingredient.id,
    });
    expect(recomputed).toEqual([[ingredient.id]]);
    expect(await resolveProductResearch(ctx.db, input, ports)).toEqual(result);
    expect(recomputed).toEqual([[ingredient.id]]);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFactEvidence)
        .where(eq(runFactEvidence.targetId, f.target.id)),
    ).toEqual(proofs);
  });
  it("records matching Ingredient proof without replacing a member's different existing link", async () => {
    const existing = await insertWithShortcode(ctx.db, "ingredient", {
      name: "Example member rice",
    });
    const proposed = await insertWithShortcode(ctx.db, "ingredient", {
      name: "Example other rice",
    });
    for (const candidate of [existing, proposed]) {
      const f = await fixture("Example Works", {
        name: `Example rice ${candidate.shortcode}`,
        ingredientId: existing.shortcode,
      });
      const result = await resolveProductResearch(
        ctx.db,
        {
          runId: f.run.id,
          callId: crypto.randomUUID(),
          proposal: {
            ...f.proposal,
            facts: [
              {
                evidenceId: f.evidence.id,
                fieldPath: "ingredientId",
                value: candidate.shortcode,
                support,
              },
            ],
          },
        },
        {
          ...f.ports,
          assess: async () => ({
            identityVerified: true,
            acceptedFacts: [0],
            acceptedIdentifiers: [],
            acceptedImages: [],
            rejected: [],
          }),
        },
      );
      const [saved] = await getDb(ctx.db)
        .select()
        .from(product)
        .where(eq(product.id, f.entity.entityId));
      expect(saved?.ingredientId).toBe(existing.id);
      expect(result.changedFields).toEqual([]);
      const proofs = await getDb(ctx.db)
        .select()
        .from(runFactEvidence)
        .where(eq(runFactEvidence.targetId, f.target.id));
      const matches = candidate.id === existing.id;
      expect(result.verifiedFields).toEqual(matches ? ["ingredientId"] : []);
      expect(proofs.map(({ value }) => value)).toEqual(
        matches ? [existing.id] : [],
      );
      expect(result.contradictions).toEqual(
        matches
          ? []
          : [
              {
                fieldPath: "ingredientId",
                currentValue: existing.id,
                proposedValue: proposed.shortcode,
              },
            ],
      );
    }
  });
  it("refuses a deleted catalog link while accepting an independent existing Plant and never changing money or stock", async () => {
    const missing = await insertWithShortcode(ctx.db, "ingredient", {
      name: "Example deleted ingredient",
      deletedAt: new Date(),
    });
    const plant = await insertWithShortcode(ctx.db, "plant", {
      name: "Example basil plant",
    });
    const f = await fixture();
    const [before] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    const result = await resolveProductResearch(
      ctx.db,
      {
        runId: f.run.id,
        callId: crypto.randomUUID(),
        proposal: {
          ...f.proposal,
          facts: [
            {
              evidenceId: f.evidence.id,
              fieldPath: "ingredientId",
              value: missing.shortcode,
              support,
            },
            {
              evidenceId: f.evidence.id,
              fieldPath: "growsPlantId",
              value: plant.shortcode,
              support,
            },
          ],
        },
      },
      f.ports,
    );
    expect(result.refusals).toEqual([
      expect.objectContaining({ path: "ingredientId" }),
    ]);
    expect(result.changedFields).toEqual(["growsPlantId"]);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(saved).toMatchObject({
      ingredientId: null,
      growsPlantId: plant.id,
      price: before?.price,
      stockTracked: before?.stockTracked,
    });
    const proofs = await getDb(ctx.db)
      .select()
      .from(runFactEvidence)
      .where(eq(runFactEvidence.targetId, f.target.id));
    expect(proofs.map(({ fieldPath }) => fieldPath)).toEqual(["growsPlantId"]);
  });
  it("refuses Ingredient classification under a member's non-food category without losing another supported fact", async () => {
    const [category] = await getDb(ctx.db)
      .select()
      .from(productCategory)
      .where(
        and(eq(productCategory.feature, "tools"), notDeleted(productCategory)),
      )
      .limit(1);
    if (!category) throw new Error("Synthetic tools root missing");
    const ingredient = await insertWithShortcode(ctx.db, "ingredient", {
      name: "Example rice ingredient",
    });
    const f = await fixture("Example Works", {
      categoryId: parseShortcodeFor("productCategory", category.shortcode),
    });
    const result = await resolveProductResearch(
      ctx.db,
      {
        runId: f.run.id,
        callId: crypto.randomUUID(),
        proposal: {
          ...f.proposal,
          facts: [
            {
              evidenceId: f.evidence.id,
              fieldPath: "ingredientId",
              value: ingredient.shortcode,
              support,
            },
            {
              evidenceId: f.evidence.id,
              fieldPath: "model",
              value: "Q-17",
              support,
            },
          ],
        },
      },
      f.ports,
    );
    expect(result.refusals).toEqual([
      expect.objectContaining({ path: "ingredientId" }),
    ]);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(saved).toMatchObject({
      ingredientId: null,
      categoryId: category.id,
      model: "Q-17",
    });
  });
  it.each(["category_first", "ingredient_first"] as const)(
    "stages accepted classification before dependent catalog links without losing independent facts (%s)",
    async (ordering) => {
      const [category] = await getDb(ctx.db)
        .select()
        .from(productCategory)
        .where(
          and(
            eq(productCategory.feature, "tools"),
            notDeleted(productCategory),
          ),
        )
        .limit(1);
      if (!category) throw new Error("Synthetic tools root missing");
      const ingredient = await insertWithShortcode(ctx.db, "ingredient", {
        name: "Example unsupported rice ingredient",
      });
      const f = await fixture();
      const categoryFact = {
        evidenceId: f.evidence.id,
        fieldPath: "categoryId",
        value: category.shortcode,
        support,
      };
      const ingredientFact = {
        evidenceId: f.evidence.id,
        fieldPath: "ingredientId",
        value: ingredient.shortcode,
        support,
      };
      const result = await resolveProductResearch(
        ctx.db,
        {
          runId: f.run.id,
          callId: crypto.randomUUID(),
          proposal: {
            ...f.proposal,
            facts: [
              ...(ordering === "category_first"
                ? [categoryFact, ingredientFact]
                : [ingredientFact, categoryFact]),
              f.proposal.facts[1]!,
            ],
          },
        },
        {
          ...f.ports,
          assess: async () => ({
            identityVerified: true,
            acceptedFacts: [0, 1, 2],
            acceptedIdentifiers: [],
            acceptedImages: [],
            rejected: [],
          }),
        },
      );
      expect(result.refusals).toEqual([
        expect.objectContaining({ path: "ingredientId" }),
      ]);
      expect(result.verifiedFields).toEqual(["categoryId", "model"]);
      const [saved] = await getDb(ctx.db)
        .select()
        .from(product)
        .where(eq(product.id, f.entity.entityId));
      expect(saved).toMatchObject({
        categoryId: category.id,
        ingredientId: null,
        model: "Q-17",
      });
      const proofs = await getDb(ctx.db)
        .select({ fieldPath: runFactEvidence.fieldPath })
        .from(runFactEvidence)
        .where(eq(runFactEvidence.targetId, f.target.id));
      expect(proofs.map((proof) => proof.fieldPath).sort()).toEqual([
        "categoryId",
        "model",
      ]);
    },
  );
  async function retainImage(f: Awaited<ReturnType<typeof fixture>>) {
    const sourceUrl = "https://cdn.example.test/selected-small.png";
    const candidateRef = crypto.randomUUID();
    const retained = {
      evidenceId: f.evidence.id,
      observation: {
        sourceURL: "https://shop.example.test/device?size=small",
        servedURL: "https://shop.example.test/device?size=small",
        canonicalUrl: null,
        title: "Selected small device",
        capturedAt: new Date().toISOString(),
        readableText: retainedText,
        textTruncated: false,
        truncated: false,
        variantMarkers: ["size=small"],
        observationId: null,
        actions: [],
        actionsTruncated: false,
        links: [],
        authenticationRequired: false,
        structuredProducts: null,
      },
      identifierCandidates: [],
      imageCandidates: [
        {
          candidateRef,
          evidenceId: f.evidence.id,
          sourceURL: "https://shop.example.test/device?size=small",
          url: sourceUrl,
          highResolutionUrl: null,
          alt: "Selected small Q-17",
          naturalWidth: 800,
          naturalHeight: 800,
        },
      ],
    };
    await getDb(ctx.db)
      .update(runEvidence)
      .set({ sourceMetadata: { research: retained } })
      .where(eq(runEvidence.id, f.evidence.id));
    return { candidateRef, sourceUrl };
  }
  // Corrective attempts must retain work, replay without effects, refresh only
  // their own write fence, and stop repeated unsupported completion claims.
  it("retains a refused Product attempt and accepts a corrected fresh call after partial writes", async () => {
    const f = await fixture(UNSPECIFIED_MANUFACTURER);
    const firstInput = {
      runId: f.run.id,
      callId: "synthetic-partial-attempt",
      proposal: f.proposal,
    };
    const first = await resolveProductResearch(ctx.db, firstInput, {
      ...f.ports,
      assess: async () => ({
        identityVerified: true,
        acceptedIdentifiers: [],
        acceptedImages: [],
        acceptedFacts: [1],
        rejected: [
          { path: "facts.0", reason: "Maker claim needs corrected support." },
        ],
      }),
    });
    expect(first).toMatchObject({
      outcome: "partially_verified",
      changedFields: ["model"],
    });
    const [active] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.target.id));
    const current = await productEnrichmentTarget(
      getDb(ctx.db),
      f.entity.entityId,
    );
    expect(active).toMatchObject({
      state: "needs_evidence",
      completedAt: null,
      outcome: null,
      targetFingerprint: current?.fingerprint,
    });
    expect(await resolveProductResearch(ctx.db, firstInput, f.ports)).toEqual(
      first,
    );
    const correctedInput = {
      ...firstInput,
      callId: "synthetic-corrected-attempt",
      proposal: { ...f.proposal, status: "researched_with_gaps" as const },
    };
    const corrected = await resolveProductResearch(
      ctx.db,
      correctedInput,
      f.ports,
    );
    expect(corrected.changedFields).toEqual(["manufacturer"]);
    expect(
      await resolveProductResearch(ctx.db, correctedInput, f.ports),
    ).toEqual(corrected);
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFactEvidence)
        .where(eq(runFactEvidence.targetId, f.target.id)),
    ).toHaveLength(2);
    await expect(
      resolveProductResearch(
        ctx.db,
        { ...correctedInput, callId: "synthetic-late-attempt" },
        f.ports,
      ),
    ).rejects.toThrow(/settled|closed/);
  });
  it("settles repeated unsupported Product proposals with an honest attempt-limit gap", async () => {
    const f = await fixture();
    const ports = {
      ...f.ports,
      assess: async () => ({
        identityVerified: true,
        acceptedIdentifiers: [],
        acceptedImages: [],
        acceptedFacts: [],
        rejected: [{ path: "facts", reason: "Unsupported facts." }],
      }),
    };
    for (let attempt = 1; attempt <= 3; attempt++) {
      const input = {
        runId: f.run.id,
        callId: `synthetic-refusal-${attempt}`,
        proposal: f.proposal,
      };
      const receipt = await resolveProductResearch(ctx.db, input, ports);
      expect(await resolveProductResearch(ctx.db, input, ports)).toEqual(
        receipt,
      );
      const [target] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.id, f.target.id));
      expect(target?.state).toBe(
        attempt === 3 ? "unresolved" : "needs_evidence",
      );
    }
    const lastReceipt = await resolveProductResearch(
      ctx.db,
      { runId: f.run.id, callId: "synthetic-refusal-3", proposal: f.proposal },
      ports,
    );
    expect(lastReceipt.refusals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "attempt",
          reason: expect.stringMatching(/limit/i),
        }),
      ]),
    );
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual([]);
  });
  it("counts repeated accepted Product proofs with the same refusal as zero progress", async () => {
    const f = await fixture();
    const ports = {
      ...f.ports,
      assess: async () => ({
        identityVerified: true,
        acceptedFacts: [0],
        acceptedIdentifiers: [],
        acceptedImages: [],
        rejected: [{ path: "facts.1", reason: "Model remains unsupported." }],
      }),
    };
    for (let attempt = 1; attempt <= 4; attempt++) {
      const input = {
        runId: f.run.id,
        callId: `synthetic-matching-proof-${attempt}`,
        proposal: f.proposal,
      };
      const receipt = await resolveProductResearch(ctx.db, input, ports);
      expect(await resolveProductResearch(ctx.db, input, ports)).toEqual(
        receipt,
      );
      const [target] = await getDb(ctx.db)
        .select()
        .from(runTarget)
        .where(eq(runTarget.id, f.target.id));
      expect(target?.state).toBe(
        attempt === 4 ? "unresolved" : "needs_evidence",
      );
    }
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFactEvidence)
        .where(eq(runFactEvidence.targetId, f.target.id)),
    ).toHaveLength(1);
  });
  it("keeps an empty verified Product proposal active without claiming supported facts", async () => {
    const f = await fixture();
    const result = await resolveProductResearch(
      ctx.db,
      {
        runId: f.run.id,
        callId: "synthetic-empty-attempt",
        proposal: { ...f.proposal, facts: [] },
      },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedIdentifiers: [],
          acceptedImages: [],
          acceptedFacts: [],
          rejected: [],
        }),
      },
    );
    expect(result).toMatchObject({
      outcome: "researched_with_gaps",
      verifiedFields: [],
      changedFields: [],
    });
    expect(result.refusals).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "attempt" })]),
    );
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.target.id));
    expect(target).toMatchObject({
      state: "needs_evidence",
      completedAt: null,
    });
  });
  it("replaces the imported manufacturer sentinel with a supported maker and retained proof", async () => {
    const f = await fixture(UNSPECIFIED_MANUFACTURER);
    const input = {
      runId: f.run.id,
      callId: crypto.randomUUID(),
      proposal: f.proposal,
    };
    const result = await resolveProductResearch(ctx.db, input, f.ports);
    expect(result).toMatchObject({
      outcome: "researched_with_gaps",
      changedFields: ["manufacturer", "model"],
      verifiedFields: ["manufacturer", "model"],
      contradictions: [],
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(saved).toMatchObject({
      manufacturer: "Example Works",
      model: "Q-17",
    });
    const proofs = await getDb(ctx.db)
      .select()
      .from(runFactEvidence)
      .where(eq(runFactEvidence.targetId, f.target.id));
    expect(proofs).toHaveLength(2);
    expect(
      proofs.find((proof) => proof.fieldPath === "manufacturer"),
    ).toMatchObject({
      value: "Example Works",
      evidenceId: f.evidence.id,
      support,
    });
    expect(await resolveProductResearch(ctx.db, input, f.ports)).toEqual(
      result,
    );
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFactEvidence)
        .where(eq(runFactEvidence.targetId, f.target.id)),
    ).toHaveLength(2);
  });

  it("fills a supported fact and settles explicit gaps from a selected variant without JSON-LD", async () => {
    const f = await fixture();
    const input = {
      runId: f.run.id,
      callId: crypto.randomUUID(),
      proposal: { ...f.proposal, status: "researched_with_gaps" as const },
    };
    const first = await resolveProductResearch(ctx.db, input, f.ports);
    expect(first).toMatchObject({
      outcome: "researched_with_gaps",
      changedFields: ["model"],
      verifiedFields: ["manufacturer", "model"],
    });
    const [settled] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.target.id));
    expect(settled).toMatchObject({
      state: "unresolved",
      outcome: "researched_with_gaps",
    });
    expect(await resolveProductResearch(ctx.db, input, f.ports)).toEqual(first);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(saved).toMatchObject({
      manufacturer: "Example Works",
      model: "Q-17",
    });
    expect(
      await getDb(ctx.db)
        .select()
        .from(runFactEvidence)
        .where(eq(runFactEvidence.targetId, f.target.id)),
    ).toHaveLength(2);
    await expect(
      resolveProductResearch(
        ctx.db,
        { ...input, callId: crypto.randomUUID() },
        f.ports,
      ),
    ).rejects.toThrow(/settled|closed/);
  });
  it("refuses unsupported ordered-variant identity and evidence from another task before writing", async () => {
    const f = await fixture();
    const callId = crypto.randomUUID();
    const refused = await resolveProductResearch(
      ctx.db,
      { runId: f.run.id, callId, proposal: f.proposal },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: false,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          rejected: [
            {
              path: "identity",
              reason:
                "Source describes the large device, not the ordered small device.",
            },
          ],
        }),
      },
    );
    expect(refused).toMatchObject({
      outcome: "researched_with_gaps",
      changedFields: [],
      verifiedFields: [],
      refusals: expect.arrayContaining([
        expect.objectContaining({ path: "identity" }),
      ]),
    });
    const [attempt] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.operationId, callId));
    expect(attempt).toMatchObject({
      state: "completed",
      result: { attempt: expect.objectContaining(f.proposal) },
    });
    await getDb(ctx.db)
      .update(runEvidence)
      .set({ targetId: null })
      .where(eq(runEvidence.id, f.evidence.id));
    await expect(
      resolveProductResearch(
        ctx.db,
        { runId: f.run.id, callId: crypto.randomUUID(), proposal: f.proposal },
        f.ports,
      ),
    ).rejects.toThrow(/evidence|task/);
    const [saved] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(saved?.model).toBe("");
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual([]);
  });
  it("records genuine ambiguity with refused proposed facts without accepting family-level provenance", async () => {
    const f = await fixture();
    const input = {
      runId: f.run.id,
      callId: crypto.randomUUID(),
      proposal: {
        ...f.proposal,
        status: "ambiguous" as const,
        facts: [f.proposal.facts[0]!],
        detail: "The receipt cannot distinguish two incompatible variants.",
      },
    };
    const ports = {
      ...f.ports,
      assess: async () => ({
        identityVerified: false,
        acceptedFacts: [0],
        acceptedIdentifiers: [],
        acceptedImages: [],
        rejected: [{ path: "identity", reason: "Exact variant is unknown." }],
      }),
    };
    const result = await resolveProductResearch(ctx.db, input, ports);
    expect(result).toMatchObject({
      outcome: "ambiguous",
      changedFields: [],
      verifiedFields: [],
      refusals: [{ path: "identity", reason: "Exact variant is unknown." }],
    });
    expect(await resolveProductResearch(ctx.db, input, ports)).toEqual(result);
    const [attempt] = await getDb(ctx.db)
      .select()
      .from(runOperation)
      .where(eq(runOperation.operationId, input.callId));
    expect(attempt).toMatchObject({
      state: "completed",
      result: { attempt: expect.objectContaining(input.proposal) },
    });
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.target.id));
    expect(target).toMatchObject({ state: "unresolved", outcome: "ambiguous" });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(saved).toMatchObject({ manufacturer: "Example Works", model: "" });
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual([]);
  });
  it.each([true, false])(
    "does not report partial verification or lose declined proposals (reasons supplied: %s)",
    async (withReasons) => {
      const f = await fixture();
      const callId = crypto.randomUUID();
      const proposal = { ...f.proposal, status: "partially_verified" as const };
      const result = await resolveProductResearch(
        ctx.db,
        {
          runId: f.run.id,
          callId,
          proposal,
        },
        {
          ...f.ports,
          assess: async () => ({
            identityVerified: true,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [],
            rejected: withReasons
              ? [{ path: "facts", reason: "No proposed fact is supported." }]
              : [],
          }),
        },
      );
      expect(result).toMatchObject({
        outcome: "researched_with_gaps",
        changedFields: [],
        verifiedFields: [],
      });
      expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual([]);
      const [attempt] = await getDb(ctx.db)
        .select()
        .from(runOperation)
        .where(eq(runOperation.operationId, callId));
      expect(attempt).toMatchObject({
        state: "completed",
        result: { attempt: expect.objectContaining(proposal) },
      });
    },
  );
  it("settles an honest no-source outcome without claiming identity or writing facts", async () => {
    const f = await fixture();
    const result = await resolveProductResearch(
      ctx.db,
      {
        runId: f.run.id,
        callId: crypto.randomUUID(),
        proposal: {
          workRef: f.target.id,
          status: "no_source_found",
          identity: { evidenceIds: [], reasoning: "No source was available." },
          detail: "No source was found for the ordered variant.",
        },
      },
      {
        assess: async () => ({
          identityVerified: false,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          rejected: [],
        }),
      },
    );
    expect(result).toMatchObject({
      outcome: "no_source_found",
      changedFields: [],
      verifiedFields: [],
    });
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.target.id));
    expect(target).toMatchObject({
      state: "unresolved",
      outcome: "no_source_found",
    });
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual([]);
  });
  it("downgrades a verified proposal with no supported operands to researched gaps", async () => {
    const f = await fixture();
    const result = await resolveProductResearch(
      ctx.db,
      {
        runId: f.run.id,
        callId: crypto.randomUUID(),
        proposal: { ...f.proposal, facts: [] },
      },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [],
          rejected: [],
        }),
      },
    );
    expect(result).toMatchObject({
      outcome: "researched_with_gaps",
      changedFields: [],
      verifiedFields: [],
    });
    const [target] = await getDb(ctx.db)
      .select()
      .from(runTarget)
      .where(eq(runTarget.id, f.target.id));
    expect(target).toMatchObject({
      state: "needs_evidence",
      outcome: null,
    });
  });
  // Distinct issuers sharing a first hostname label must not collide, cross
  // Product ownership/proof, or open a false product-match review.
  it("learns the same visible retailer SKU for distinct full-host issuers without a product-match review", async () => {
    const objects = new Map<string, Uint8Array>();
    const storage = {
      put: async (key: string, bytes: Uint8Array) => {
        objects.set(key, new Uint8Array(bytes));
      },
    };
    const readEvidence: ResearchEvidenceReader = async (evidence) => {
      const bytes = objects.get(evidence.objectKey);
      if (!bytes) throw new Error("Synthetic issuer original missing");
      return new TextDecoder().decode(bytes);
    };
    const members = [];
    for (const issuer of [
      {
        sourceURL: "https://shop.alpha.example.test/device?size=small",
        name: "Example Alpha Works Q-17 small device",
        manufacturer: "Example Alpha Works",
      },
      {
        sourceURL: "https://shop.beta.example.test/device?size=small",
        name: "Example Beta Works R-28 small device",
        manufacturer: "Example Beta Works",
      },
    ]) {
      const sourceText = `${issuer.name}; selected size: small; retailer SKU SHARED-17`;
      const content = `<html><body><h1>${issuer.name}</h1><p>${sourceText}</p></body></html>`;
      const f = await fixture(
        issuer.manufacturer,
        { name: issuer.name },
        sourceText,
      );
      const retained = await retainResearchObservation(
        ctx.db,
        {
          runId: f.run.id,
          workRef: f.target.id,
          callId: "synthetic-issuer-page",
          kind: "web_page",
          sourceMetadata: {
            sourceURL: issuer.sourceURL,
            servedURL: issuer.sourceURL,
          },
          content,
        },
        { storage, keyPrefix: "synthetic" },
      );
      const claimSupport = {
        observation: sourceText,
        reasoning:
          "The retained seller page identifies this exact small device and its retailer SKU.",
        selectedVariant: {
          identity: issuer.name,
          attributes: { size: "small" },
          reasoning:
            "The source explicitly identifies the selected small device.",
        },
      };
      const proposal = researchWorkResolve.parse({
        workRef: f.target.id,
        status: "verified",
        identity: {
          evidenceIds: [retained.evidenceId],
          reasoning: claimSupport.reasoning,
        },
        identifierClaims: [
          {
            evidenceId: retained.evidenceId,
            kind: "retailer_sku",
            externalId: "SHARED-17",
            support: claimSupport,
          },
        ],
        detail: "Verified the selected device and its seller-issued SKU.",
      });
      // Only the external semantic judgment and object store are scripted;
      // retention, task ownership, issuer resolution and domain learning run.
      const assess: ResearchAssessor = async (input) => {
        expect(input.context).toMatchObject({
          product: { name: issuer.name, manufacturer: issuer.manufacturer },
        });
        expect(input.observations).toHaveLength(1);
        const original = input.observations[0]!;
        expect(original).toMatchObject({
          evidenceId: retained.evidenceId,
          content,
        });
        expect(original.metadata).toMatchObject({
          researchUploadState: "uploaded",
          research: {
            evidenceId: retained.evidenceId,
            observation: {
              sourceURL: issuer.sourceURL,
              servedURL: issuer.sourceURL,
            },
          },
        });
        expect(retained.observation.readableText).toContain(sourceText);
        expect(input.proposal.identifierClaims).toEqual(
          proposal.identifierClaims,
        );
        return {
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedIdentifierClaims: [0],
          acceptedImages: [],
          rejected: [],
        };
      };
      const result = await resolveProductResearch(
        ctx.db,
        { runId: f.run.id, callId: "synthetic-learn-issuer-sku", proposal },
        { readEvidence, assess },
      );
      expect(result.changedFields).toEqual(["externalIds"]);
      expect(result.refusals).toEqual([]);
      const owned = await getDb(ctx.db)
        .select()
        .from(entityExternalId)
        .where(eq(entityExternalId.entityId, f.entity.entityId));
      expect(owned).toHaveLength(1);
      const member = owned[0]!;
      expect(member).toMatchObject({
        entityKind: "product",
        kind: "retailer_sku",
        externalId: "SHARED-17",
        url: issuer.sourceURL,
        deletedAt: null,
      });
      const proofs = await getDb(ctx.db)
        .select()
        .from(runFactEvidence)
        .where(eq(runFactEvidence.targetId, f.target.id));
      expect(proofs).toHaveLength(1);
      expect(proofs[0]).toMatchObject({
        evidenceId: retained.evidenceId,
        fieldPath: `externalIds.i${member.id.replaceAll("-", "")}`,
        value: {
          kind: "retailer_sku",
          externalId: "SHARED-17",
          source: member.source,
        },
        support: claimSupport,
      });
      members.push(member);
    }
    expect(members[0]!.source).not.toBe(members[1]!.source);
    expect(await getDb(ctx.db).select().from(entityExternalId)).toHaveLength(2);
    expect(await getDb(ctx.db).select().from(productMatchCandidate)).toEqual(
      [],
    );
  });
  it("learns an accepted visible SKU without JSON-LD and retains member provenance", async () => {
    const f = await fixture();
    const result = await resolveProductResearch(
      ctx.db,
      {
        runId: f.run.id,
        callId: crypto.randomUUID(),
        proposal: {
          ...f.proposal,
          facts: [],
          identifierClaims: [
            {
              evidenceId: f.evidence.id,
              kind: "retailer_sku",
              externalId: "SMALL-17",
              support,
            },
          ],
        },
      },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedIdentifierClaims: [0],
          acceptedImages: [],
          rejected: [],
        }),
      },
    );
    const [member] = await getDb(ctx.db)
      .select()
      .from(entityExternalId)
      .where(eq(entityExternalId.entityId, f.entity.entityId));
    expect(member).toMatchObject({
      kind: "retailer_sku",
      externalId: "SMALL-17",
      source: "host-73686f702e6578616d706c652e74657374",
      url: "https://shop.example.test/device?size=small",
    });
    expect(result.outcome).toBe("researched_with_gaps");
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toMatchObject([
      {
        fieldPath: `externalIds.i${member!.id.replaceAll("-", "")}`,
        value: {
          kind: "retailer_sku",
          externalId: "SMALL-17",
          source: "host-73686f702e6578616d706c652e74657374",
        },
      },
    ]);
  });
  it("proposes a collision for a visible SKU without moving the identifier", async () => {
    const f = await fixture();
    const owner = await createProductFixture(
      ctx.db,
      makeProductInput({ name: "Example existing SKU owner" }),
      ctx.actor,
    );
    const issuer = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example registered shop",
      website: "https://shop.example.test",
    });
    await getDb(ctx.db)
      .insert(externalSource)
      .values({ slug: "shop", label: "Example shop", vendorId: issuer.id });
    await getDb(ctx.db).insert(entityExternalId).values({
      entityKind: "product",
      entityId: owner.entityId,
      source: "shop",
      kind: "retailer_sku",
      externalId: "SMALL-17",
      isPrimary: true,
    });
    const result = await resolveProductResearch(
      ctx.db,
      {
        runId: f.run.id,
        callId: crypto.randomUUID(),
        proposal: {
          ...f.proposal,
          facts: [],
          identifierClaims: [
            {
              evidenceId: f.evidence.id,
              kind: "retailer_sku",
              externalId: "SMALL-17",
              support,
            },
          ],
        },
      },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedIdentifierClaims: [0],
          acceptedImages: [],
          rejected: [],
        }),
      },
    );
    expect(result).toMatchObject({
      outcome: "researched_with_gaps",
      changedFields: [],
      verifiedFields: [],
    });
    expect(await getDb(ctx.db).select().from(entityExternalId)).toMatchObject([
      { entityId: owner.entityId },
    ]);
    expect(
      await getDb(ctx.db).select().from(productMatchCandidate),
    ).toHaveLength(1);
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toEqual([]);
  });
  it("releases an unreferenced image created by an import that cannot prepare proof", async () => {
    const f = await fixture();
    const { candidateRef } = await retainImage(f);
    const imported = await createImageFixture(
      ctx.db,
      "research-unprepared-image",
      { source: "catalog", sha256: "a".repeat(64) },
    );
    await expect(
      resolveProductResearch(
        ctx.db,
        {
          runId: f.run.id,
          callId: crypto.randomUUID(),
          proposal: {
            ...f.proposal,
            facts: [],
            imageCandidates: [
              { candidateRef, evidenceIds: [f.evidence.id], support },
            ],
          },
        },
        {
          ...f.ports,
          assess: async () => ({
            identityVerified: true,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [0],
            rejected: [],
          }),
          importImage: async () => ({
            imageId: imported.shortcode,
            key: imported.key,
            url: imported.url,
            created: true,
          }),
          deleteImageObjects: async () => {},
        },
      ),
    ).rejects.toThrow(/retained source/);
    const [remaining] = await getDb(ctx.db)
      .select()
      .from(image)
      .where(eq(image.id, imported.id));
    expect(!remaining || remaining.deletedAt !== null).toBe(true);
    expect(
      await getDb(ctx.db)
        .select()
        .from(entityAttachment)
        .where(eq(entityAttachment.entityId, f.entity.entityId)),
    ).toEqual([]);
  });
  it("appends a representative retained image without replacing an owned cover and proves its member", async () => {
    const f = await fixture();
    const own = await createImageFixture(ctx.db, "research-owned-cover", {
      source: "own",
    });
    await insertEntityAttachments(ctx.db, {
      entityId: f.entity.entityId,
      imageId: own.id,
      purpose: "item",
      sortOrder: 0,
    });
    const admitted = await productEnrichmentTarget(
      getDb(ctx.db),
      f.entity.entityId,
    );
    await getDb(ctx.db)
      .update(runTarget)
      .set({ targetFingerprint: admitted!.fingerprint })
      .where(eq(runTarget.id, f.target.id));
    const { candidateRef, sourceUrl } = await retainImage(f);
    const bytes = new TextEncoder().encode("synthetic selected image bytes");
    const imported = await createImageFixture(
      ctx.db,
      "research-representative",
      {
        source: "catalog",
        sourceAssetUrl: sourceUrl,
        sha256: await sha256Hex(bytes),
      },
    );
    const proposal = {
      ...f.proposal,
      facts: [],
      imageCandidates: [
        { candidateRef, evidenceIds: [f.evidence.id], support },
      ],
    };
    const result = await resolveProductResearch(
      ctx.db,
      { runId: f.run.id, callId: crypto.randomUUID(), proposal },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [],
          acceptedIdentifiers: [],
          acceptedImages: [0],
          rejected: [],
        }),
        importImage: async () => ({
          imageId: imported.shortcode,
          key: imported.key,
          url: imported.url,
          created: false,
        }),
      },
    );
    expect(result.outcome).toBe("researched_with_gaps");
    const attachments = await getDb(ctx.db)
      .select()
      .from(entityAttachment)
      .where(eq(entityAttachment.entityId, f.entity.entityId))
      .orderBy(entityAttachment.sortOrder);
    expect(attachments).toMatchObject([
      { imageId: own.id, sortOrder: 0 },
      { imageId: imported.id, sortOrder: 1 },
    ]);
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toMatchObject([
      {
        fieldPath: `images.i${attachments[1]!.id.replaceAll("-", "")}`,
        value: {
          imageId: imported.shortcode,
          contentHash: imported.sha256,
          sourceAssetUrl: sourceUrl,
        },
      },
    ]);
    const [original] = await getDb(ctx.db)
      .select()
      .from(image)
      .where(eq(image.id, own.id));
    expect(original?.source).toBe("own");
  });
  it("preserves populated contradictions while accepting independent supported facts", async () => {
    const f = await fixture();
    const contradictory = researchWorkResolve.parse({
      ...f.proposal,
      facts: [
        { ...f.proposal.facts[0], value: "Different Works" },
        f.proposal.facts[1],
      ],
    });
    const result = await resolveProductResearch(
      ctx.db,
      { runId: f.run.id, callId: crypto.randomUUID(), proposal: contradictory },
      f.ports,
    );
    expect(result).toMatchObject({
      outcome: "partially_verified",
      changedFields: ["model"],
      verifiedFields: ["model"],
      contradictions: [
        {
          fieldPath: "manufacturer",
          currentValue: "Example Works",
          proposedValue: "Different Works",
        },
      ],
    });
    const [saved] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(saved?.manufacturer).toBe("Example Works");
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toHaveLength(1);
  });

  async function supportedCorrection() {
    const sourceText = "Different Works Q-17, small; retailer SKU SMALL-17";
    const f = await fixture("Example Works", {}, sourceText);
    const fact = {
      ...f.proposal.facts[0]!,
      value: "Different Works",
      support: {
        ...support,
        observation: "Different Works Q-17, small",
        reasoning:
          "The source identifies Different Works as the maker of the ordered Q-17 small variant.",
      },
    };
    await resolveProductResearch(
      ctx.db,
      {
        runId: f.run.id,
        callId: "synthetic-supported-maker-correction",
        proposal: { ...f.proposal, facts: [fact, f.proposal.facts[1]!] },
      },
      f.ports,
    );
    const detail = await loadRunDetail(ctx.db, f.run.shortcode);
    expect(detail.findings).toHaveLength(1);
    const finding = detail.findings[0];
    if (!finding) throw new Error("Supported Product correction has no review");
    const fix = z
      .object({
        kind: z.literal("research_field_correction"),
        reviewSnapshot: z.object({ fingerprint: z.string() }),
      })
      .parse(finding.proposedFix);
    return { ...f, finding, fix, fact, sourceText };
  }

  it("allows a Product holder to stage a finding while explicit correction approval waits on that Product", async () => {
    const f = await supportedCorrection();
    const storage = vi
      .spyOn(productionBrowserEvidenceStorage, "get")
      .mockImplementation(async (key) => {
        if (key !== f.evidence.objectKey)
          throw new Error("Synthetic review read an unrelated evidence key");
        return f.sourceText;
      });
    let applying: ReturnType<typeof resolveRunFinding> | undefined;
    try {
      await withTransaction(ctx.db, async (tx) => {
        await tx
          .select({ id: product.id })
          .from(product)
          .where(eq(product.id, f.entity.entityId))
          .for("update");
        applying = resolveRunFinding(
          ctx.db,
          {
            id: f.finding.id,
            action: "apply",
            reviewedFingerprint: f.fix.reviewSnapshot.fingerprint,
          },
          ctx.actor,
        );
        applying.catch(() => undefined);
        await expect
          .poll(
            async () => {
              const result = await getDb(ctx.db).execute(sql`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND pid <> pg_backend_pid()
                AND wait_event_type = 'Lock' AND query LIKE '%"Product"%'
                AND query LIKE '%for update%'
            ) AS waiting
          `);
              return z.object({ waiting: z.boolean() }).parse(result.rows[0])
                .waiting;
            },
            { interval: 20, timeout: 5_000 },
          )
          .toBe(true);
        // The producer already owns the Product; its real Finding FK needs a
        // compatible owner lock even while another approval waits on Product.
        await tx.execute(sql`SET LOCAL lock_timeout = '500ms'`);
        await tx.insert(runFinding).values({
          runId: f.run.id,
          ledgerPartyId: f.run.ledgerPartyId!,
          entityKind: "product",
          entityId: f.entity.entityId,
          kind: "other",
          summary: "Synthetic concurrent supported review",
          evidenceFingerprint: await sha256Hex("synthetic-concurrent-review"),
        });
      });
      expect(await applying).toMatchObject({ status: "applied" });
      const saved = await getDb(ctx.db).query.product.findFirst({
        where: eq(product.id, f.entity.entityId),
      });
      expect(saved?.manufacturer).toBe("Different Works");
      const staged = await getDb(ctx.db)
        .select()
        .from(runFinding)
        .where(eq(runFinding.status, "open"));
      expect(staged.map((row) => row.summary)).toEqual([
        "Synthetic concurrent supported review",
      ]);
    } finally {
      try {
        if (applying) await applying;
      } finally {
        storage.mockRestore();
      }
    }
  });

  it("invalidates and recomputes recipes for both Ingredients after explicit supported Product correction", async () => {
    const previous = await findOrCreateIngredient(
      ctx.db,
      "Synthetic previous rice",
    );
    const replacement = await findOrCreateIngredient(
      ctx.db,
      "Synthetic replacement rice",
    );
    const sourceText =
      "The purchased small bag contains Synthetic replacement rice.";
    const f = await fixture(
      "Example Works",
      {
        name: "Synthetic purchased rice bag",
        ingredientId: parseShortcodeFor("ingredient", previous.shortcode),
        price: 4,
        unitMappings: [
          {
            a: { value: 1, unit: "lb" },
            b: { value: 4, unit: "dollar" },
            source: "synthetic-published-pack",
          },
        ],
      },
      sourceText,
    );
    const recipes = await Promise.all(
      [previous, replacement].map((ingredient) =>
        createRecipeFixture(
          ctx.db,
          makeRecipeInput({
            name: `${ingredient.name} recipe`,
            sections: [
              {
                instructions: [{ instruction: "Mix" }],
                ingredients: [
                  ingredientRef(ingredient.shortcode, {
                    amounts: [{ value: 2, unit: "lb" }],
                  }),
                ],
              },
            ],
          }),
          ctx.actor,
        ),
      ),
    );
    const oldRecipe = recipes[0]!;
    const newRecipe = recipes[1]!;
    const costing = createTestRequestContext(ctx.db, {
      auth: { userId: ctx.actor.userId },
    }).services.recipeCosting;
    await costing.recompute(recipes.map((recipe) => recipe.entityId));
    const beforeOld = await getRecipeTotalsState(ctx.db, oldRecipe.entityId);
    const beforeNew = await getRecipeTotalsState(ctx.db, newRecipe.entityId);
    expect(beforeOld?.totalsComputedAt).toBeInstanceOf(Date);
    expect(beforeNew?.totalsComputedAt).toBeInstanceOf(Date);
    expect(beforeOld?.totals?.cost).toMatchObject({
      status: "complete",
      lower: 8,
      upper: null,
    });
    expect(beforeNew?.totals?.cost.status).toBe("unavailable");
    await resolveProductResearch(
      ctx.db,
      {
        runId: f.run.id,
        callId: "synthetic-supported-ingredient-correction",
        proposal: {
          ...f.proposal,
          facts: [
            {
              evidenceId: f.evidence.id,
              fieldPath: "ingredientId",
              value: replacement.shortcode,
              support: {
                observation: sourceText,
                reasoning:
                  "The purchased bag names the replacement catalog Ingredient.",
              },
            },
          ],
        },
      },
      {
        ...f.ports,
        assess: async () => ({
          identityVerified: true,
          acceptedFacts: [0],
          acceptedIdentifiers: [],
          acceptedImages: [],
          rejected: [],
        }),
      },
    );
    const detail = await loadRunDetail(ctx.db, f.run.shortcode);
    expect(detail.findings).toHaveLength(1);
    const finding = detail.findings[0]!;
    const fix = z
      .object({
        kind: z.literal("research_field_correction"),
        reviewSnapshot: z.object({ fingerprint: z.string() }),
      })
      .parse(finding.proposedFix);
    const storage = vi
      .spyOn(productionBrowserEvidenceStorage, "get")
      .mockImplementation(async (key) => {
        if (key !== f.evidence.objectKey)
          throw new Error(
            "Synthetic correction read an unrelated evidence key",
          );
        return sourceText;
      });
    try {
      // Queue transport is the external seam; invalidation and costing still
      // use real persisted recipes and the ordinary RecipeCosting service.
      setCfEnv(
        fromPartial<Env>({
          BACKGROUND_QUEUE: { send: async () => {}, sendBatch: async () => {} },
        }),
      );
      expect(
        await resolveRunFinding(
          ctx.db,
          {
            id: finding.id,
            action: "apply",
            reviewedFingerprint: fix.reviewSnapshot.fingerprint,
          },
          ctx.actor,
          costing,
        ),
      ).toMatchObject({ status: "applied" });
      const saved = await getDb(ctx.db).query.product.findFirst({
        where: eq(product.id, f.entity.entityId),
      });
      expect(saved?.ingredientId).toBe(replacement.id);
      expect(
        (await getRecipeTotalsState(ctx.db, oldRecipe.entityId))
          ?.totalsComputedAt,
      ).toBeNull();
      expect(
        (await getRecipeTotalsState(ctx.db, newRecipe.entityId))
          ?.totalsComputedAt,
      ).toBeNull();
      await costing.recompute(recipes.map((recipe) => recipe.entityId));
      const afterOld = await getRecipeTotalsState(ctx.db, oldRecipe.entityId);
      const afterNew = await getRecipeTotalsState(ctx.db, newRecipe.entityId);
      expect(afterOld?.totalsComputedAt).toBeInstanceOf(Date);
      expect(afterNew?.totalsComputedAt).toBeInstanceOf(Date);
      expect(afterOld?.totals?.cost.status).toBe("unavailable");
      expect(afterNew?.totals?.cost).toMatchObject({
        status: "complete",
        lower: 8,
        upper: null,
      });
    } finally {
      storage.mockRestore();
      setCfEnv(undefined);
    }
  });

  it("makes a supported Product contradiction reviewable with retained support and an explicit apply action", async () => {
    const f = await supportedCorrection();
    const report = await runReport(
      ctx.db,
      "run.import-findings",
      f.run.shortcode,
      undefined,
    );
    const rows = report.blocks.flatMap((block) =>
      block.kind === "records" ? block.rows : [],
    );
    const shown = rows.find((row) => row.key === f.finding.id);
    const text = shown?.lines?.map((line) => line.text).join("\n");
    expect(text).toContain("Example Works");
    expect(text).toContain("Different Works");
    expect(text).toContain(f.fact.support.reasoning);
    expect(shown?.commands).toContainEqual(
      expect.objectContaining({
        request: {
          kind: "resolve-finding",
          findingId: f.finding.id,
          decision: "apply",
          reviewedFingerprint: f.fix.reviewSnapshot.fingerprint,
        },
      }),
    );
    const [before] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(before?.manufacturer).toBe("Example Works");
    const storage = vi
      .spyOn(productionBrowserEvidenceStorage, "get")
      .mockImplementation(async (key) => {
        if (key !== f.evidence.objectKey)
          throw new Error("Synthetic review read an unrelated evidence key");
        return f.sourceText;
      });
    try {
      expect(
        await resolveRunFinding(
          ctx.db,
          {
            id: f.finding.id,
            action: "apply",
            reviewedFingerprint: f.fix.reviewSnapshot.fingerprint,
          },
          ctx.actor,
        ),
      ).toMatchObject({ status: "applied" });
    } finally {
      storage.mockRestore();
    }
    const [after] = await getDb(ctx.db)
      .select()
      .from(product)
      .where(eq(product.id, f.entity.entityId));
    expect(after?.manufacturer).toBe("Different Works");
    expect(await getDb(ctx.db).select().from(runFactEvidence)).toContainEqual(
      expect.objectContaining({
        fieldPath: "manufacturer",
        evidenceId: f.evidence.id,
        value: "Different Works",
        support: f.fact.support,
      }),
    );
  });

  it.each(["member edit", "changed evidence"] as const)(
    "refuses stale approval of a supported Product contradiction after %s",
    async (changed) => {
      const f = await supportedCorrection();
      if (changed === "member edit")
        await updateProduct(
          ctx.db,
          f.entity.entityId,
          { manufacturer: "Member chosen maker" },
          ctx.actor,
        );
      const storage = vi
        .spyOn(productionBrowserEvidenceStorage, "get")
        .mockImplementation(async (key) => {
          if (key !== f.evidence.objectKey)
            throw new Error("Synthetic review read an unrelated evidence key");
          return changed === "changed evidence"
            ? "Synthetic changed original; the selected variant is absent."
            : f.sourceText;
        });
      try {
        await expect(
          resolveRunFinding(
            ctx.db,
            {
              id: f.finding.id,
              action: "apply",
              reviewedFingerprint: f.fix.reviewSnapshot.fingerprint,
            },
            ctx.actor,
          ),
        ).rejects.toThrow(/changed|stale|checksum|snapshot/i);
      } finally {
        storage.mockRestore();
      }
      const [saved] = await getDb(ctx.db)
        .select()
        .from(product)
        .where(eq(product.id, f.entity.entityId));
      expect(saved?.manufacturer).toBe(
        changed === "member edit" ? "Member chosen maker" : "Example Works",
      );
      expect(await getDb(ctx.db).select().from(runFactEvidence)).toHaveLength(
        1,
      );
    },
  );

  it.each(["provisional", "member selected", "unknown history"] as const)(
    "promotes a verified exact-variant image only over a provisional thumbnail while preserving %s cover intent",
    async (coverIntent) => {
      const f = await fixture();
      const thumbnail = await createImageFixture(
        ctx.db,
        "synthetic-order-line-thumbnail",
        {
          source: "catalog",
          sourceAssetUrl: "https://cdn.example.test/order-small.jpg",
        },
      );
      if (coverIntent === "unknown history") {
        await insertEntityAttachments(ctx.db, {
          entityId: f.entity.entityId,
          imageId: thumbnail.id,
          purpose: "item",
          sortOrder: 0,
        });
      } else {
        const vendor = await insertWithShortcode(ctx.db, "vendor", {
          name: "Synthetic thumbnail merchant",
        });
        const purchase = await insertWithShortcode(ctx.db, "purchase", {
          vendorId: vendor.id,
          orderId: "SYNTHETIC-THUMBNAIL-ORDER",
          date: "2026-09-21",
        });
        await insertWithShortcode(ctx.db, "expense", {
          name: "Example small device",
          purchaseId: purchase.id,
          productId: f.entity.entityId,
          cost: 1,
          date: "2026-09-21",
          lineKind: "principal",
          costType: "materials",
        });
        await attachOrderLineThumbnails(
          ctx.db,
          {
            purchaseId: purchase.id,
            mailContent: {
              bodyHtml: '<img src="https://cdn.example.test/order-small.jpg">',
              bodyText: null,
            },
            lines: [
              {
                title: "Example small device",
                imageUrl: "https://cdn.example.test/order-small.jpg",
              },
            ],
          },
          {
            importImage: async () => ({
              imageId: thumbnail.shortcode,
              created: false,
            }),
          },
        );
      }
      if (coverIntent === "member selected")
        await updateProduct(
          ctx.db,
          f.entity.entityId,
          { imageOrder: [parseShortcodeFor("image", thumbnail.shortcode)] },
          ctx.actor,
        );
      const admitted = await productEnrichmentTarget(
        getDb(ctx.db),
        f.entity.entityId,
      );
      if (!admitted) throw new Error("Synthetic Product image scope missing");
      await getDb(ctx.db)
        .update(runTarget)
        .set({ targetFingerprint: admitted.fingerprint })
        .where(eq(runTarget.id, f.target.id));
      const { candidateRef, sourceUrl } = await retainImage(f);
      const verified = await createImageFixture(
        ctx.db,
        "synthetic-verified-variant",
        {
          source: "catalog",
          sourceAssetUrl: sourceUrl,
          sha256: "b".repeat(64),
        },
      );
      await resolveProductResearch(
        ctx.db,
        {
          runId: f.run.id,
          callId: crypto.randomUUID(),
          proposal: {
            ...f.proposal,
            facts: [],
            imageCandidates: [
              { candidateRef, evidenceIds: [f.evidence.id], support },
            ],
          },
        },
        {
          ...f.ports,
          assess: async () => ({
            identityVerified: true,
            acceptedFacts: [],
            acceptedIdentifiers: [],
            acceptedImages: [0],
            rejected: [],
          }),
          importImage: async () => ({
            imageId: verified.shortcode,
            key: verified.key,
            url: verified.url,
            created: false,
          }),
        },
      );
      const attachments = await getDb(ctx.db)
        .select()
        .from(entityAttachment)
        .where(eq(entityAttachment.entityId, f.entity.entityId))
        .orderBy(entityAttachment.sortOrder);
      expect(attachments.map((row) => row.imageId)).toEqual(
        coverIntent === "provisional"
          ? [verified.id, thumbnail.id]
          : [thumbnail.id, verified.id],
      );
      expect(await getDb(ctx.db).select().from(runFactEvidence)).toHaveLength(
        1,
      );
    },
  );
});

// Registry ownership is a DB boundary: name-only registrations cannot authorize
// a host, and competing or incompatible bindings must leave historical rows alone.
describe("Product identifier issuer registry", () => {
  const ctx = withTestDb();
  it("reuses the sole explicitly bound source for canonical domain aliases and URL-less orders", async () => {
    const issuer = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example canonical retailer",
      website: "https://example.test",
      browserDomains: ["catalog.example.test"],
    });
    await getDb(ctx.db).insert(externalSource).values({
      slug: "retained-catalog",
      label: "Example catalog",
      vendorId: issuer.id,
    });
    for (const url of [
      "https://www.example.test/p/1",
      "https://catalog.example.test/p/2",
      undefined,
    ]) {
      expect(
        await resolveProductIdentifierSource(ctx.db, {
          url,
          vendorId: issuer.id,
        }),
      ).toBe("retained-catalog");
    }
  });
  it("preserves unowned legacy prefixes and distinguishes punctuation in full hosts", async () => {
    await getDb(ctx.db)
      .insert(externalSource)
      .values({ slug: "shop", label: "Legacy shop" });
    const first = await resolveProductIdentifierSource(ctx.db, {
      url: "https://shop.alpha.example.test/p/1",
    });
    const second = await resolveProductIdentifierSource(ctx.db, {
      url: "https://shop-alpha.example.test/p/1",
    });
    expect(first).toBe("host-73686f702e616c7068612e6578616d706c652e74657374");
    expect(second).toBe("host-73686f702d616c7068612e6578616d706c652e74657374");
    expect(
      await getDb(ctx.db)
        .select()
        .from(externalSource)
        .where(eq(externalSource.slug, "shop")),
    ).toMatchObject([{ vendorId: null }]);
  });
  it("refuses ambiguous canonical domain ownership", async () => {
    for (const name of ["Example first retailer", "Example second retailer"]) {
      await insertWithShortcode(ctx.db, "vendor", {
        name,
        website: "https://example.test",
      });
    }
    await expect(
      resolveProductIdentifierSource(ctx.db, {
        url: "https://example.test/p/1",
      }),
    ).rejects.toThrow("ambiguous");
  });
  it("refuses competing sources for one canonical Vendor", async () => {
    const issuer = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example retailer",
      website: "https://example.test",
    });
    await getDb(ctx.db)
      .insert(externalSource)
      .values([
        { slug: "example-first", label: "First", vendorId: issuer.id },
        { slug: "example-second", label: "Second", vendorId: issuer.id },
      ]);
    await expect(
      resolveProductIdentifierSource(ctx.db, {
        url: "https://example.test/p/1",
      }),
    ).rejects.toThrow("competing");
  });
  it("refuses an encoded full-host registration bound to an incompatible Vendor", async () => {
    const other = await insertWithShortcode(ctx.db, "vendor", {
      name: "Example other retailer",
      website: "https://other.test",
    });
    await getDb(ctx.db).insert(externalSource).values({
      slug: "host-6578616d706c652e74657374",
      label: "Conflicting registration",
      vendorId: other.id,
    });
    await expect(
      resolveProductIdentifierSource(ctx.db, {
        url: "https://example.test/p/1",
      }),
    ).rejects.toThrow("incompatible");
    expect(await getDb(ctx.db).select().from(externalSource)).toMatchObject([
      { vendorId: other.id },
    ]);
  });
});
