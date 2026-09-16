import { createHash } from "node:crypto";
import { Pool } from "pg";
import "./build-constants";
import { RECIPE_FLOW_PRIMARY_FEATURE } from "../../src/server/ai/features";
import { fillInput, waitForFormHydration } from "./e2e-helpers";
import { expect, test } from "./e2e-test";

const MODEL = RECIPE_FLOW_PRIMARY_FEATURE.model;
const PROMPT_VERSION = RECIPE_FLOW_PRIMARY_FEATURE.promptVersion;

test.describe("Recipe Flow", () => {
  test("renders a cached walkthrough and retains table instruction details", async ({
    page,
  }) => {
    await page.goto("/recipes/new");
    await waitForFormHydration(page);
    await fillInput(page, "Enter recipe name", "E2E Branching Biscuits");

    await page.getByRole("button", { name: /Add Instruction/i }).click();
    await page
      .getByRole("textbox", { name: "Step" })
      .fill("Mix in two tablespoons of water, then knead until smooth.");
    await page.getByRole("button", { name: /^Create$/i }).click();
    await expect(page).toHaveURL(
      /\/recipes\/RCP-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}/,
      { timeout: 15000 },
    );

    const recipeShortcode = page
      .url()
      .match(/\/recipes\/(RCP-[A-Z0-9]{4})/)?.[1];
    expect(recipeShortcode).toBeTruthy();

    const databaseUrl = process.env.E2E_DATABASE_URL;
    if (!databaseUrl || !recipeShortcode) {
      throw new Error("E2E database or recipe flow identity was unavailable");
    }
    const generatedAt = new Date().toISOString();

    const pool = new Pool({ connectionString: databaseUrl });
    try {
      // The URL only carries the public shortcode; resolve it to the real row
      // (and its uuid `id`, which `AiAnalysis.entityId` below still stores).
      const recipeResult = await pool.query<{ id: string; name: string }>(
        `SELECT "id", "name" FROM "Recipe" WHERE "shortcode" = $1`,
        [recipeShortcode],
      );
      const recipeRow = recipeResult.rows[0];
      if (!recipeRow) throw new Error("Recipe fixture missing");
      const recipeId = recipeRow.id;

      const sectionResult = await pool.query<{
        id: string;
        instructions: Array<{ text: string }>;
        name: string | null;
      }>(
        `SELECT "id", "name", "instructions" FROM "RecipeSection"
         WHERE "recipeId" = $1 AND "deletedAt" IS NULL
         ORDER BY "sortOrder" ASC NULLS LAST, "createdAt" ASC`,
        [recipeId],
      );
      const sectionRow = sectionResult.rows.find(
        (section) => section.instructions.length > 0,
      );
      if (!sectionRow) throw new Error("Recipe fixture missing");

      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            recipe: {
              title: recipeRow.name,
              sections: sectionResult.rows.map((section) => ({
                sectionId: section.id,
                name: section.name,
                ingredients: [],
                instructions: section.instructions.map(
                  (instruction, instructionIndex) => ({
                    instructionIndex,
                    text: instruction.text,
                  }),
                ),
              })),
            },
            guidance: null,
          }),
        )
        .digest("hex");
      const artifact = {
        plan: {
          schemaVersion: 1,
          setup: [],
          sources: [
            {
              id: "water",
              kind: "unlisted",
              label: "Water",
              instructionRefs: [
                { sectionId: sectionRow.id, instructionIndex: 0 },
              ],
            },
          ],
          operations: [
            {
              id: "mix-dough",
              label: "Mix dough",
              outputLabel: "Smooth dough",
              inputs: [{ kind: "source", id: "water" }],
              instructionRefs: [
                { sectionId: sectionRow.id, instructionIndex: 0 },
              ],
              annotations: [{ kind: "cue", text: "until smooth" }],
            },
          ],
          outputOperationIds: ["mix-dough"],
          walkthrough: {
            overview: "Bring the dough together, then knead until smooth.",
            stops: [
              {
                id: "dough",
                title: "Make the dough",
                explanation:
                  "The source instruction brings mixing and kneading together in one step.",
                operationIds: ["mix-dough"],
              },
            ],
          },
        },
        guidance: null,
        warnings: [
          {
            code: "unlisted-input",
            message:
              "Water appears in the instructions but not the ingredient list.",
            nodeIds: ["water"],
          },
        ],
        contentFingerprint: fingerprint,
        model: MODEL,
        promptVersion: PROMPT_VERSION,
        generatedAt,
      };

      await pool.query(
        `INSERT INTO "AiAnalysis"
          ("entityType", "entityId", "feature", "model", "promptVersion", "inputFingerprint", "result")
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
        [
          "recipe",
          recipeId,
          "recipe-flow",
          MODEL,
          PROMPT_VERSION,
          fingerprint,
          JSON.stringify(artifact),
        ],
      );
    } finally {
      await pool.end();
    }

    await page.getByRole("button", { name: "Flow view", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "E2E Branching Biscuits", level: 2 }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole("navigation", { name: "Walkthrough stops" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", {
          name: "Recipe instructions for Make the dough",
        })
        .getByText(
          "Mix in two tablespoons of water, then knead until smooth.",
          { exact: true },
        ),
    ).toBeVisible();
    await page
      .getByText("Why this step · AI explanation", { exact: true })
      .click();
    await expect(
      page.getByText(
        "The source instruction brings mixing and kneading together in one step.",
        { exact: true },
      ),
    ).toBeVisible();

    await page.getByRole("button", { name: "Table view", exact: true }).click();
    await expect(page.getByText("Water", { exact: true })).toBeVisible();
    await expect(page.getByText("Mix dough", { exact: true })).toBeVisible();
    await expect(page.getByText("until smooth", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: /Mix dough/i }).click();
    await expect(
      page.getByText(
        "Mix in two tablespoons of water, then knead until smooth.",
        { exact: true },
      ),
    ).toBeVisible();
  });
});
