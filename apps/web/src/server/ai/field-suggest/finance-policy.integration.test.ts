import type { FieldSuggestionsInput } from "@cubby/schemas/ai";
import { spendingCategoryShortcode } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it, vi } from "vitest";

import type { JevPort } from "~/server/ai/jev";
import { spendingCategory, vendor } from "~/server/db/schema";
import {
  entityKernelContextSchema,
  executeEntity,
} from "~/server/entity-kernel";
import { getDb } from "~/server/repo/database-helpers";
import { insertWithShortcode } from "~/server/repo/shortcode-utils";
import { ensureRun } from "~/server/runs/ensure-run";
import { createTestRequestContext } from "~/server/testing/request-context";

import { suggestFields } from "./suggest-fields";

// Failure modes: invented or deleted categories; lost parent context; policy
// proposals overwriting explicit decisions before a separate reviewed update.
// Only the external model response is supplied; roster/read/write paths are real.
function modelPicking(...needles: string[]) {
  return vi.fn<JevPort>(async (input) => {
    const entries = Object.entries(input.questions.selection.criteria);
    const winner = entries.find(([, label]) =>
      needles.some((needle) => label.includes(needle)),
    );
    if (!winner) throw new Error(`Missing model choice: ${needles.join(", ")}`);
    return {
      answers: {
        selection: {
          type: "choice",
          choice: winner[0],
          confidence: 0.95,
          probabilities: Object.fromEntries(
            entries.map(([key]) => [
              key,
              key === winner[0] ? 0.95 : 0.05 / (entries.length - 1),
            ]),
          ),
        },
      },
    };
  });
}

describe("reviewed finance suggestions", () => {
  const ctx = withTestDb();
  async function suggest(input: FieldSuggestionsInput, jev: JevPort) {
    const runId = await ensureRun(ctx.db, ctx.actor, { purpose: "ai_suggest" });
    return suggestFields(ctx.db, runId, input, { jev });
  }

  it.each(["purchase", "expense"] as const)(
    "%s selects a live child with parent context and applies only after review",
    async (entity) => {
      const parent = await insertWithShortcode(ctx.db, "spendingCategory", {
        name: "Fixture food",
        evidenceExpectation: "unknown",
        productExpectation: "unknown",
      });
      const child = await insertWithShortcode(ctx.db, "spendingCategory", {
        name: "Fixture dining",
        parentId: parent.id,
        evidenceExpectation: "not_expected",
        productExpectation: "not_expected",
      });
      await insertWithShortcode(ctx.db, "spendingCategory", {
        name: "Retired fixture dining",
        deletedAt: new Date(),
        evidenceExpectation: "unknown",
        productExpectation: "unknown",
      });
      const before = await getDb(ctx.db).select().from(spendingCategory);
      const jev = modelPicking(child.shortcode);
      const result = await suggest(
        {
          entity,
          basisMode: "provided",
          targets: ["spendingCategoryId"],
          basis: {
            merchant: "Fixture restaurant",
            sourceCategory: "Restaurants",
            rawDescription: "Dinner",
            displayLabel: "Restaurants",
            name: "Restaurants",
            vendor: "Fixture restaurant",
          },
        },
        jev,
      );
      expect(result.suggestions.spendingCategoryId).toMatchObject({
        value: child.shortcode,
        operation: "set",
      });
      const request = jev.mock.calls[0]![0];
      expect(request.state).toContain("Restaurants");
      const roster = Object.values(request.questions.selection.criteria).join(
        "\n",
      );
      expect(roster).toContain("Fixture food");
      expect(roster).toContain("Fixture dining");
      expect(
        Object.values(request.questions.selection.criteria).find((label) =>
          label.includes(child.shortcode),
        ),
      ).toContain("Fixture food > Fixture dining");
      expect(roster).not.toContain("Retired fixture dining");
      expect(await getDb(ctx.db).select().from(spendingCategory)).toEqual(
        before,
      );
      // A separate reviewed write can apply a policy proposal; suggestion itself cannot.
      const policy = await suggest(
        {
          entity: "spendingCategory",
          basisMode: "provided",
          targets: ["evidenceExpectation"],
          basis: { name: "Fixture groceries", parentId: parent.shortcode },
        },
        modelPicking("not_expected:"),
      );
      expect(policy.suggestions.evidenceExpectation?.value).toBe(
        "not_expected",
      );
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(spendingCategory)
            .where(eq(spendingCategory.id, parent.id))
        )[0]?.evidenceExpectation,
      ).toBe("unknown");
      await executeEntity(
        entityKernelContextSchema.parse({
          ...createTestRequestContext(ctx.db),
          actorContext: ctx.actor,
        }),
        {
          action: "update",
          entity: "spendingCategory",
          id: spendingCategoryShortcode.parse(parent.shortcode),
          data: { evidenceExpectation: "not_expected" },
        },
      );
      expect(
        (
          await getDb(ctx.db)
            .select()
            .from(spendingCategory)
            .where(eq(spendingCategory.id, parent.id))
        )[0]?.evidenceExpectation,
      ).toBe("not_expected");
    },
  );

  it("does not call the model or invent a category when no live roster exists", async () => {
    await insertWithShortcode(ctx.db, "spendingCategory", {
      name: "Deleted fixture",
      deletedAt: new Date(),
      evidenceExpectation: "unknown",
      productExpectation: "unknown",
    });
    const jev = modelPicking("invented");
    const result = await suggest(
      {
        entity: "purchase",
        basisMode: "provided",
        targets: ["spendingCategoryId"],
        basis: { displayLabel: "Fixture dinner", notes: "Restaurant meal" },
      },
      jev,
    );
    expect(result.suggestions.spendingCategoryId).toBeNull();
    expect(result.outcomes?.spendingCategoryId).toEqual({
      kind: "skipped",
      reason: "no_candidates",
    });
    expect(jev).not.toHaveBeenCalled();
  });

  it.each([
    ["Amazon", "required"],
    ["BiRite groceries", "not_expected"],
    ["Unknown mixed retailer", "unknown"],
  ])(
    "returns a reviewed %s receipt proposal without changing explicit policy",
    async (name, expected) => {
      const row = await insertWithShortcode(ctx.db, "vendor", {
        name,
        evidenceExpectation: "not_expected",
      });
      const result = await suggest(
        {
          entity: "vendor",
          basisMode: "provided",
          targets: ["evidenceExpectation"],
          basis: { name },
        },
        modelPicking(`${expected}:`),
      );
      expect(result.suggestions.evidenceExpectation).toMatchObject({
        value: expected,
        operation: "set",
      });
      expect(
        (
          await getDb(ctx.db).select().from(vendor).where(eq(vendor.id, row.id))
        )[0]?.evidenceExpectation,
      ).toBe("not_expected");
    },
  );

  it.each(["purchase", "financialTransaction"] as const)(
    "%s resolves source/vendor evidence while leaving explicit receipt policy unchanged",
    async (entity) => {
      const row = await insertWithShortcode(ctx.db, "vendor", {
        name: "Home Depot",
        evidenceExpectation: "not_expected",
      });
      const jev = modelPicking("required:");
      const result = await suggest(
        {
          entity,
          basisMode: "provided",
          targets: ["evidenceExpectation"],
          basis: {
            vendorId: row.shortcode,
            merchant: "Home Depot",
            sourceCategory: "Home improvement",
            notes: "Fixture hardware purchase",
          },
        },
        jev,
      );
      expect(result.suggestions.evidenceExpectation?.value).toBe("required");
      expect(jev.mock.calls[0]![0].state).toContain("Home Depot");
      expect(
        (
          await getDb(ctx.db).select().from(vendor).where(eq(vendor.id, row.id))
        )[0]?.evidenceExpectation,
      ).toBe("not_expected");
    },
  );

  it("offers category product policy independently from receipt policy", async () => {
    const result = await suggest(
      {
        entity: "spendingCategory",
        basisMode: "provided",
        targets: ["productExpectation", "evidenceExpectation"],
        basis: { name: "Fixture durable tools" },
      },
      modelPicking("Durable goods", "not_expected:"),
    );
    expect(result.suggestions.productExpectation?.value).toBe("required");
    expect(result.suggestions.evidenceExpectation?.value).toBe("not_expected");
    expect(await getDb(ctx.db).select().from(spendingCategory)).toHaveLength(0);
  });
});
