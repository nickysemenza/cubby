/**
 * One-off backfill for the garden Plant entity (docs/plans/garden-plants-and-verdicts.md §7).
 * Run after the additive `db:push` and before the old columns are dropped:
 *
 *   pnpm --dir apps/web db:backfill-garden-plants            # dry run
 *   pnpm --dir apps/web db:backfill-garden-plants --write    # apply
 *
 * Reads the legacy `Planting.ingredientId`/`variety`, `Ingredient.gardenGuideKey`
 * and `Product.growsIngredientId` columns with raw SQL. Idempotent: rows that
 * already carry a `plantId`/`growsPlantId` are skipped. Writes no audit entries.
 */
import "dotenv/config";
import { generateShortcode } from "@cubby/shared";
import { Pool, type PoolClient } from "pg";

const write = process.argv.includes("--write");
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

type PlantingRow = {
  id: string;
  ingredientId: string;
  ingredientName: string;
  gardenGuideKey: string | null;
  variety: string | null;
};

const plantKey = (ingredientId: string, name: string) =>
  `${ingredientId}:${name.trim().toLowerCase()}`;

const insertPlant = async (
  client: PoolClient,
  plant: { name: string; ingredientId: string; gardenGuideKey: string | null },
): Promise<string> => {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO "Plant" ("shortcode", "name", "ingredientId", "gardenGuideKey")
     VALUES ($1, $2, $3, $4) RETURNING "id"`,
    [
      generateShortcode("plant"),
      plant.name,
      plant.ingredientId,
      plant.gardenGuideKey,
    ],
  );
  return rows[0]!.id;
};

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  const plantings = (
    await client.query<PlantingRow>(
      `SELECT pl."id", pl."ingredientId", i."name" AS "ingredientName",
              i."gardenGuideKey", NULLIF(trim(pl."variety"), '') AS "variety"
       FROM "Planting" pl JOIN "Ingredient" i ON i."id" = pl."ingredientId"
       WHERE pl."plantId" IS NULL AND pl."ingredientId" IS NOT NULL
       ORDER BY pl."createdAt"`,
    )
  ).rows;

  // One Plant per (ingredient, trimmed lower-cased variety); the first-seen
  // spelling names it. A null variety makes a species-level Plant named after
  // the ingredient.
  const existing = (
    await client.query<{ id: string; ingredientId: string; name: string }>(
      `SELECT "id", "ingredientId", "name" FROM "Plant"
       WHERE "deletedAt" IS NULL AND "ingredientId" IS NOT NULL`,
    )
  ).rows;
  const plantIdByKey = new Map(
    existing.map((row) => [plantKey(row.ingredientId, row.name), row.id]),
  );
  const created: string[] = [];
  const resolvePlant = async (
    ingredientId: string,
    name: string,
    gardenGuideKey: string | null,
  ) => {
    const key = plantKey(ingredientId, name);
    let id = plantIdByKey.get(key);
    if (!id) {
      id = await insertPlant(client, {
        name: name.trim(),
        ingredientId,
        gardenGuideKey,
      });
      plantIdByKey.set(key, id);
      created.push(name.trim());
    }
    return id;
  };

  for (const row of plantings) {
    const plantId = await resolvePlant(
      row.ingredientId,
      row.variety ?? row.ingredientName,
      row.gardenGuideKey,
    );
    await client.query(`UPDATE "Planting" SET "plantId" = $1 WHERE "id" = $2`, [
      plantId,
      row.id,
    ]);
  }

  // A garden source Product takes the Plant its plantings grew (the most
  // common one), else a species-level Plant for the crop it named.
  const products = (
    await client.query<{
      id: string;
      ingredientId: string;
      ingredientName: string;
      gardenGuideKey: string | null;
      sourcedPlantId: string | null;
    }>(
      `SELECT p."id", p."growsIngredientId" AS "ingredientId", i."name" AS "ingredientName",
              i."gardenGuideKey",
              (SELECT pl."plantId" FROM "Planting" pl
               WHERE pl."sourceProductId" = p."id" AND pl."plantId" IS NOT NULL
               GROUP BY pl."plantId" ORDER BY count(*) DESC LIMIT 1) AS "sourcedPlantId"
       FROM "Product" p JOIN "Ingredient" i ON i."id" = p."growsIngredientId"
       WHERE p."growsPlantId" IS NULL`,
    )
  ).rows;
  for (const row of products) {
    const plantId =
      row.sourcedPlantId ??
      (await resolvePlant(
        row.ingredientId,
        row.ingredientName,
        row.gardenGuideKey,
      ));
    await client.query(
      `UPDATE "Product" SET "growsPlantId" = $1 WHERE "id" = $2`,
      [plantId, row.id],
    );
  }

  const lowered = new Map<string, string[]>();
  for (const name of created) {
    const key = name.toLowerCase().replace(/[^a-z0-9]/gu, "");
    lowered.set(key, [...(lowered.get(key) ?? []), name]);
  }
  console.log(
    JSON.stringify(
      {
        mode: write ? "write" : "dry-run",
        plantingsLinked: plantings.length,
        productsLinked: products.length,
        plantsCreated: created.length,
        // Judgment calls for the MCP cleanup pass (plan §7 step 5).
        reviewNames: created.filter((name) => /unknown|\bor\b|\?/iu.test(name)),
        nearDuplicates: [...lowered.values()].filter(
          (names) => names.length > 1,
        ),
      },
      null,
      2,
    ),
  );
  await client.query(write ? "COMMIT" : "ROLLBACK");
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
