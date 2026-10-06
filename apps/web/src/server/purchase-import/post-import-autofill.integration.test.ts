import type {
  FieldSuggestionsInput,
  FieldSuggestionsOut,
} from "@cubby/schemas/ai";
import { actorInRun } from "@cubby/schemas/context";
import type { RunId } from "@cubby/schemas/identifiers";
import { and, eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import type { Database } from "~/server/db";
import { auditLog, product } from "~/server/db/schema";
import { logAuditEntry } from "~/server/repo/audit-log";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";

import { autoFillCreatedProducts } from "./post-import-autofill";

// A Product an import just created gets the fields Jev is nearly certain of.
// Failure modes: a sub-0.95 guess is written; a field the member (or an
// earlier step) already set is overwritten; a Product the import only linked
// is touched; the plant/ingredient pick ignores the category just applied;
// the write leaves no audit trail back to the import run.
describe("auto-fill after an import", () => {
  const ctx = withTestDb();

  async function seed() {
    const runId = await ensureRun(ctx.db, ctx.actor, {
      // Any run id works: auto-fill keys on the audit trail, not the purpose.
      purpose: "ai_suggest",
    });
    const category = await insertWithShortcode(ctx.db, "productCategory", {
      name: `Vegetable seeds ${crypto.randomUUID()}`,
    });
    const plant = await insertWithShortcode(ctx.db, "plant", {
      name: "Example Sun Tomato",
    });
    const created = await insertWithShortcode(ctx.db, "product", {
      name: "Example Sun Tomato seed packet",
      manufacturer: "",
    });
    const preset = await insertWithShortcode(ctx.db, "product", {
      name: "Example basil seed packet",
      manufacturer: "",
    });
    const linked = await insertWithShortcode(ctx.db, "product", {
      name: "Example trowel",
      manufacturer: "",
    });
    for (const row of [created, preset])
      await logAuditEntry(ctx.db, actorInRun(ctx.actor, runId), {
        entityKind: "product",
        entityId: row.id,
        action: "create",
      });
    const otherCategory = await insertWithShortcode(ctx.db, "productCategory", {
      name: `Herb seeds ${crypto.randomUUID()}`,
    });
    await getDb(ctx.db)
      .update(product)
      .set({ categoryId: otherCategory.id })
      .where(eq(product.id, preset.id));
    return { runId, category, plant, created, preset, linked, otherCategory };
  }

  it("writes only near-certain picks into empty fields of Products the import created", async () => {
    const seeded = await seed();
    const calls: FieldSuggestionsInput[] = [];
    const suggest = async (
      _db: Database,
      _runId: RunId,
      input: FieldSuggestionsInput,
    ): Promise<FieldSuggestionsOut> => {
      calls.push(input);
      const [target] = input.targets;
      const pick = (value: string, probability: number) => ({
        suggestions: {
          [target!]: {
            value,
            label: value,
            detail: null,
            confidence: "high" as const,
            probability,
            reasoning: "synthetic",
            alternatives: [],
            operation: "set" as const,
            removals: [],
          },
        },
        outcomes: {
          [target!]: {
            kind: "evaluated" as const,
            answer: "pick" as const,
            confidence: "high" as const,
            probability,
            alternatives: [],
          },
        },
      });
      if (target === "categoryId") return pick(seeded.category.shortcode, 0.97);
      if (target === "growsPlantId") return pick(seeded.plant.shortcode, 0.99);
      return pick("ING-ZZZZ", 0.9);
    };

    await autoFillCreatedProducts(ctx.db, { runId: seeded.runId }, { suggest });

    const rows = await getDb(ctx.db)
      .select({
        id: product.id,
        categoryId: product.categoryId,
        growsPlantId: product.growsPlantId,
        ingredientId: product.ingredientId,
      })
      .from(product);
    const byId = new Map(rows.map((row) => [row.id, row]));
    expect(byId.get(seeded.created.id)).toMatchObject({
      categoryId: seeded.category.id,
      growsPlantId: seeded.plant.id,
      // 0.90 is below the bar.
      ingredientId: null,
    });
    // The member's category stays; the linked Product is untouched.
    expect(byId.get(seeded.preset.id)?.categoryId).toBe(
      seeded.otherCategory.id,
    );
    expect(byId.get(seeded.linked.id)).toMatchObject({
      categoryId: null,
      growsPlantId: null,
    });
    expect(
      calls.some((call) => call.entityId === seeded.linked.shortcode),
    ).toBe(false);
    // Later targets see the category the first pick applied.
    expect(
      calls.find(
        (call) =>
          call.entityId === seeded.created.shortcode &&
          call.targets[0] === "growsPlantId",
      )?.basis.categoryId,
    ).toBe(seeded.category.shortcode);
    const audits = await getDb(ctx.db)
      .select({ runId: auditLog.runId })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entityId, seeded.created.id),
          eq(auditLog.action, "update"),
        ),
      );
    expect(audits.length).toBeGreaterThan(0);
    expect(audits.every((audit) => audit.runId === seeded.runId)).toBe(true);
  });
});
