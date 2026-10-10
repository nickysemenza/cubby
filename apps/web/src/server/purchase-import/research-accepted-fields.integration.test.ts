import { acceptedResearchFact } from "@cubby/schemas/research";
import { eq } from "drizzle-orm";
import { taxonomyShortcode } from "tooling/product-category-fixtures";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { suggestion } from "~/server/db/schema";
import { productEnrichmentTarget } from "~/server/purchase-import/product-enrichment-target";
import { commitAcceptedResearchFields } from "~/server/purchase-import/research-accepted-fields";
import { getDb, withTransaction } from "~/server/repo/database-helpers";
import { createProduct } from "~/server/repo/product/crud";
import { makeProductInput } from "~/server/repo/repo.fixtures";
import { resolveLiveShortcode } from "~/server/repo/shortcode-resolver";
import { ensureRun } from "~/server/runs/ensure-run";

describe("accepted research writes", () => {
  const ctx = withTestDb();

  it("supersedes a pending Suggestion when accepted research fills its field", async () => {
    const product = await createProduct(
      ctx.db,
      makeProductInput({
        name: "Synthetic researched product",
        manufacturer: "Synthetic maker",
      }),
      ctx.actor,
    );
    const productId = await resolveLiveShortcode(ctx.db, product.id, "product");
    if (!productId) throw new Error("Synthetic Product record is missing");
    const runId = await ensureRun(ctx.db, ctx.actor, {
      purpose: "ai_suggest",
      trigger: "manual",
      status: "completed",
    });
    await getDb(ctx.db)
      .insert(suggestion)
      .values({
        runId,
        entity: "product",
        recordId: productId,
        field: "categoryId",
        currentValue: null,
        suggestedValue: taxonomyShortcode("food"),
        confidence: 0.8,
        model: "typesafe/jev",
        kind: "addition",
        status: "pending",
      });
    const claim = acceptedResearchFact.parse({
      evidenceId: "44444444-4444-4444-8444-444444444444",
      fieldPath: "categoryId",
      value: taxonomyShortcode("food"),
      support: {
        observation: "Synthetic package lists a food classification.",
        reasoning: "The package identifies this Product as food.",
      },
    });
    await withTransaction(ctx.db, async (tx) => {
      const target = await productEnrichmentTarget(tx, productId);
      if (!target) throw new Error("Synthetic Product target is missing");
      await commitAcceptedResearchFields(tx, {
        entityKind: "product",
        entityId: productId,
        live: target.live,
        claims: [claim],
        actor: ctx.actor,
      });
    });
    const [saved] = await getDb(ctx.db)
      .select({ status: suggestion.status })
      .from(suggestion)
      .where(eq(suggestion.recordId, productId));
    expect(saved?.status).toBe("superseded");
  });
});
