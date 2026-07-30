import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { Pool } from "pg";
import { fillInput, waitForFormHydration } from "./e2e-helpers";

const MODEL = "claude-haiku-4-5";
const PROMPT_VERSION = "2026-07-29.1";

test.describe("Recipe Flow", () => {
  test("renders a validated cached flow and opens authored instructions", async ({
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
    await expect(page).toHaveURL(/\/recipes\/[a-f0-9-]+/, { timeout: 15000 });

    const recipeId = page.url().match(/\/recipes\/([a-f0-9-]+)/)?.[1];
    expect(recipeId).toBeTruthy();

    const databaseUrl = process.env.E2E_DATABASE_URL;
    if (!databaseUrl || !recipeId) {
      throw new Error("E2E database or recipe flow identity was unavailable");
    }
    const generatedAt = new Date().toISOString();

    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const recipeResult = await pool.query<{ name: string }>(
        `SELECT "name" FROM "Recipe" WHERE "id" = $1`,
        [recipeId],
      );
      const sectionResult = await pool.query<{
        id: string;
        instructions: Array<{ instruction: string }>;
        name: string | null;
      }>(
        `SELECT "id", "name", "instructions" FROM "RecipeSection"
         WHERE "recipeId" = $1 AND "deletedAt" IS NULL
         ORDER BY "sortOrder" ASC NULLS LAST, "createdAt" ASC
         LIMIT 1`,
        [recipeId],
      );
      const recipeRow = recipeResult.rows[0];
      const sectionRow = sectionResult.rows[0];
      if (!recipeRow || !sectionRow) throw new Error("Recipe fixture missing");

      const fingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            recipe: {
              title: recipeRow.name,
              sections: [
                {
                  sectionId: sectionRow.id,
                  name: sectionRow.name,
                  ingredients: [],
                  instructions: sectionRow.instructions.map(
                    (instruction, instructionIndex) => ({
                      instructionIndex,
                      text: instruction.instruction,
                    }),
                  ),
                },
              ],
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
