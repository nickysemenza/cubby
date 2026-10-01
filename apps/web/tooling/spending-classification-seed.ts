import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { buildActorContext } from "@cubby/schemas/context";
import { z } from "zod";

import type { SpendingClassificationSeedManifest } from "../src/server/repo/spending-classification-seed";

const category = (
  key: string,
  name: string,
  parentKey: string | null = null,
  aliases: string[] = [],
) => ({ key, name, parentKey, aliases });

/** Public taxonomy labels only. Ambiguous purpose categories deliberately have no Product mapping. */
export const curatedSpendingClassificationSeed: SpendingClassificationSeedManifest =
  {
    categories: [
      category("food", "Food & Drink", null, ["Food and Drink"]),
      category("groceries", "Groceries", "food", ["Grocery"]),
      category("dining", "Dining", "food", ["Restaurants"]),
      category("coffee", "Coffee", "food", ["Coffee Shops"]),
      category("clothing", "Clothing", null, ["Apparel"]),
      category("electronics", "Electronics"),
      category("software", "Software & Digital Services", null, ["Software"]),
      category("books", "Books & Media", null, ["Books and Media"]),
      category("home", "Home"),
      category("tools", "Tools", "home"),
      category("homeImprovement", "Home Improvement", "home"),
      category("lumber", "Lumber", "homeImprovement"),
      category("paint", "Paint", "homeImprovement"),
      category("furnishings", "Furnishings", "home", ["Furniture & Decor"]),
      category("appliances", "Appliances", "home", ["Household Appliances"]),
      category("cleaning", "Cleaning", "home", ["Cleaning Supplies"]),
      category("kitchen", "Kitchen", "home"),
      category("garden", "Garden", "home", ["Gardening"]),
      category("transport", "Transport"),
      category("automotive", "Automotive", "transport", ["Auto"]),
      category("autoMaintenance", "Auto Maintenance", "automotive"),
      category("fuel", "Fuel", "automotive"),
      category("publicTransit", "Public Transit", "transport"),
      category("rideshare", "Rideshare", "transport"),
      category("education", "Education"),
      category("work", "Work"),
      category("charity", "Charity"),
      category("health", "Health & Personal Care", null, [
        "Health and Personal Care",
      ]),
      category("pets", "Pets"),
      category("gifts", "Gifts"),
      category("travel", "Travel"),
      category("utilities", "Utilities"),
      category("entertainment", "Entertainment"),
    ],
    mappings: [
      { productCategoryName: "Food", categoryKey: "groceries" },
      { productCategoryName: "Apparel", categoryKey: "clothing" },
      { productCategoryName: "Electronics", categoryKey: "electronics" },
      { productCategoryName: "Software", categoryKey: "software" },
      { productCategoryName: "Books & Media", categoryKey: "books" },
      { productCategoryName: "Tools", categoryKey: "tools" },
      { productCategoryName: "Hardware", categoryKey: "homeImprovement" },
      { productCategoryName: "Storage", categoryKey: "furnishings" },
      {
        productCategoryName: "Appliances",
        categoryKey: "appliances",
      },
      { productCategoryName: "Auto", categoryKey: "automotive" },
      { productCategoryName: "Cleaning", categoryKey: "cleaning" },
      { productCategoryName: "Furniture & Decor", categoryKey: "furnishings" },
      { productCategoryName: "Health & Personal Care", categoryKey: "health" },
      { productCategoryName: "Kitchen", categoryKey: "kitchen" },
      { productCategoryName: "Pets", categoryKey: "pets" },
      { productCategoryName: "Garden", categoryKey: "garden" },
      { productCategoryName: "Lumber & sheet goods", categoryKey: "lumber" },
      { productCategoryName: "Paint & finishes", categoryKey: "paint" },
    ],
  };

async function main() {
  const { values } = parseArgs({
    options: {
      target: { type: "string" },
      manifest: { type: "string" },
      apply: { type: "string" },
    },
  });
  const target = z.enum(["dev", "production"]).parse(values.target);
  const connection =
    target === "production"
      ? process.env.PRODUCTION_DIRECT_DATABASE_URL
      : process.env.SPENDING_CLASSIFICATION_SEED_DEV_DATABASE_URL;
  if (!connection)
    throw new Error(
      "Provide the explicit seed target database URL; ambient DATABASE_URL is not used.",
    );
  const url = new URL(connection);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:")
    throw new Error("Expected a PostgreSQL target URL.");
  if (
    target === "production"
      ? !url.hostname.endsWith(".neon.tech") || url.hostname.includes("-pooler")
      : !["localhost", "127.0.0.1"].includes(url.hostname)
  )
    throw new Error(
      "Expected a verified direct production endpoint or loopback development endpoint.",
    );
  process.env.DATABASE_URL = connection;
  delete process.env.E2E_DATABASE_URL;
  const { db, withRequestDbClient } = await import("../src/server/db");
  const { buildCrudServices } = await import("../src/server/request-context");
  const {
    spendingClassificationSeedManifest,
    previewSpendingClassificationSeed,
    applySpendingClassificationSeed,
    resolveSpendingClassificationSeedActor,
  } = await import("../src/server/repo/spending-classification-seed");
  const manifest = spendingClassificationSeedManifest.parse(
    values.manifest
      ? JSON.parse(readFileSync(values.manifest, "utf8"))
      : curatedSpendingClassificationSeed,
  );
  await withRequestDbClient(connection, async () => {
    if (values.apply) {
      const fingerprint = z
        .string()
        .regex(/^[a-f\d]{64}$/u)
        .parse(values.apply);
      const actorName = z
        .string()
        .trim()
        .min(1)
        .parse(process.env.SPENDING_CLASSIFICATION_SEED_ACTOR_NAME);
      const actor = await resolveSpendingClassificationSeedActor(db, actorName);
      const result = await applySpendingClassificationSeed(
        {
          ...buildCrudServices(db),
          actorContext: buildActorContext(actor, "api"),
        },
        manifest,
        fingerprint,
      );
      console.log(JSON.stringify({ target, applied: true, ...result }));
    } else {
      const preview = await previewSpendingClassificationSeed(db, manifest);
      const existingCategories = preview.categoryDeltas.filter(
        (row) => row.categoryKey === null && row.spendingCategoryId !== null,
      );
      const beforeExisting = existingCategories.reduce(
        (sum, row) => sum + BigInt(row.beforeCents),
        0n,
      );
      const afterExisting = existingCategories.reduce(
        (sum, row) => sum + BigInt(row.afterCents),
        0n,
      );
      const categoryDeltas = [
        ...preview.categoryDeltas
          .filter(
            (row) =>
              row.categoryKey !== null || row.spendingCategoryId === null,
          )
          .map(({ spendingCategoryId: _identity, ...row }) => ({
            ...row,
            name: row.name ?? "Unknown",
          })),
        {
          categoryKey: null,
          name: "Other existing categories",
          beforeCents: beforeExisting.toString(),
          afterCents: afterExisting.toString(),
          deltaCents: (afterExisting - beforeExisting).toString(),
        },
      ];
      // Only reviewed public manifest labels and aggregate money leave the tool.
      console.log(
        JSON.stringify({
          target,
          applied: false,
          fingerprint: preview.fingerprint,
          newCategories: preview.newCategories,
          plannedMappings: preview.plannedMappings,
          preservedMappings: preview.preservedMappings,
          categoryDeltas,
        }),
      );
    }
  });
}

if (import.meta.main) await main();
