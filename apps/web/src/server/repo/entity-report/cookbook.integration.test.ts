import { entityReportOut } from "@cubby/schemas/entity-report";
import { eq, sql } from "drizzle-orm";
import { withTestDb } from "tooling/test-setup";
import { describe, expect, it } from "vitest";

import { cookbook } from "~/server/db/schema";
import { upsertCookbook } from "~/server/repo/cookbook";
import { getDb } from "~/server/repo/database-helpers";
import { upsertCookbookRecipeFromCookbook } from "~/server/repo/import-recipe-convert";
import {
  makeCookbookExtraction,
  makeCookbookImportContext,
  makeCookbookRecipe,
} from "~/server/repo/repo.fixtures";

import { buildEntityReport } from "./index";

const runReport = {
  run_id: "synthetic-run",
  started_at: "2026-01-01T00:00:00Z",
  finished_at: "2026-01-01T00:01:00Z",
  total_cost_usd: 1.5,
  cost_complete: false,
  wall_ms: 37_400,
  incomplete: true,
  cancelled: false,
  calls: [],
  chunks: [],
  crosscheck: {
    nav_titles: 14,
    matched: 12,
    missing: [],
    phantom: [],
    recall: 0.857,
  },
  usage_by_model: [
    { model: "synthetic-large", calls: 3 },
    { model: "synthetic-small", calls: 1 },
  ],
};

/**
 * What one extraction of a cookbook cost and how complete it was, worded once on the server so web
 * and native print the same sentences. The stored tree is not read: the report ships only what the
 * section shows.
 */
describe("cookbook.extraction-report", () => {
  const ctx = withTestDb();

  const seed = async (name: string, report: typeof runReport | null) => {
    const saved = await upsertCookbook(
      ctx.db,
      {
        name,
        rawJson: makeCookbookExtraction([
          makeCookbookRecipe("Synthetic pancakes", ["2 cups flour"]),
        ]),
        report,
        author: [],
        subjects: [],
        sourceLabel: `${name}.epub`,
      },
      ctx.actor,
    );
    return saved.output.id;
  };

  const blocksOf = async (id: string) =>
    entityReportOut.parse(
      await buildEntityReport(
        ctx.db,
        { slot: "cookbook.extraction-report", id },
        async () => null,
        ctx.actor,
      ),
    ).blocks;

  it("words the cost, time, contents match, models and the incomplete warning", async () => {
    const blocks = await blocksOf(await seed("Synthetic Book A", runReport));
    expect(blocks).toEqual([
      {
        kind: "stats",
        figures: [
          { label: "Cost", value: 1.5, format: "text", text: "$1.50+" },
          { label: "Wall time", value: 37.4, format: "text", text: "37s" },
          {
            label: "Contents titles matched",
            value: 12,
            format: "text",
            text: "12/14",
          },
          { label: "Recall", value: 0.857, format: "text", text: "86%" },
        ],
      },
      {
        kind: "note",
        text: "Models: synthetic-large (3), synthetic-small (1)",
      },
      {
        kind: "note",
        text: "An unpriced model was used, so the real cost is higher than shown.",
      },
      {
        kind: "note",
        strong: true,
        tone: "warning",
        text: "This run finished incomplete — some chunks failed every model, so recipes in them are missing. Re-extract from the EPUB to recover them.",
      },
    ]);
  });

  it("says plainly when no report was stored", async () => {
    const blocks = await blocksOf(await seed("Synthetic Book B", null));
    expect(blocks).toEqual([
      {
        kind: "note",
        text: "No run report is stored for this cookbook — it was imported before runs were recorded, or from a JSON export.",
      },
    ]);
  });

  describe("cookbook.import-progress", () => {
    const progressOf = async (id: string) =>
      entityReportOut.parse(
        await buildEntityReport(
          ctx.db,
          { slot: "cookbook.import-progress", id },
          async () => null,
          ctx.actor,
        ),
      ).blocks;

    it("lists the source recipes not yet imported, each with the command that imports it", async () => {
      const pancakes = makeCookbookRecipe("Synthetic pancakes", [
        "2 cups flour",
      ]);
      const waffles = makeCookbookRecipe("Synthetic waffles", ["2 cups flour"]);
      const raw = makeCookbookExtraction([pancakes, waffles]);
      const saved = await upsertCookbook(
        ctx.db,
        { name: "Synthetic Book D", rawJson: raw, sourceLabel: "d.epub" },
        ctx.actor,
      );
      // Pancakes are in the book's recipes already; waffles are only in the source.
      await upsertCookbookRecipeFromCookbook(
        pancakes,
        "Recipes",
        { id: saved.entityId, name: "Synthetic Book D" },
        ctx.db,
        ctx.actor,
        makeCookbookImportContext(raw),
      );

      const blocks = await progressOf(saved.output.id);
      const records = blocks.find((block) => block.kind === "records");
      if (records?.kind !== "records") throw new Error("expected records");
      expect(records.title).toBe("Not yet imported");
      expect(records.rows).toMatchObject([
        {
          title: "Synthetic waffles",
          key: waffles.id,
          commands: [
            {
              label: "Add",
              confirm: null,
              request: {
                kind: "import-cookbook-recipes",
                cookbookId: saved.output.id,
                recipeIds: [waffles.id],
              },
            },
          ],
        },
      ]);
      // Reprocessing rewrites the imported recipes from the stored extraction, so it asks first.
      expect(records.commands).toMatchObject([
        {
          label: "Reprocess",
          confirm: expect.stringMatching(/no AI/),
          request: { kind: "reprocess-cookbook", cookbookId: saved.output.id },
        },
      ]);
      expect(blocks[0]).toMatchObject({
        kind: "stats",
        figures: [{ text: "1 of 2 source recipes imported" }],
      });
    });

    it("offers nothing to add or reprocess for a book in the retired format", async () => {
      const id = await seed("Synthetic Book E", runReport);
      await getDb(ctx.db)
        .update(cookbook)
        .set({ rawJson: sql`'[]'::jsonb` })
        .where(eq(cookbook.name, "Synthetic Book E"));
      expect(await progressOf(id)).toEqual([
        {
          kind: "note",
          strong: true,
          tone: "warning",
          text: "Extracted with a retired format — re-extract from the EPUB to restore the source, its run report, and sub-recipe links.",
        },
      ]);
    });
  });

  it("points a book in the retired format at re-extraction instead of reading it", async () => {
    const id = await seed("Synthetic Book C", runReport);
    await getDb(ctx.db)
      .update(cookbook)
      .set({ rawJson: sql`'[]'::jsonb` })
      .where(eq(cookbook.name, "Synthetic Book C"));
    const blocks = await blocksOf(id);
    expect(blocks).toEqual([
      {
        kind: "note",
        strong: true,
        tone: "warning",
        text: "Extracted with a retired format — re-extract from the EPUB to restore the source, its run report, and sub-recipe links.",
      },
    ]);
  });
});
