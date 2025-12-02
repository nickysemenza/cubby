import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { program } from "commander";
import fs from "fs";
import SuperJSON from "superjson";
import Papa from "papaparse";
import { type AppRouter } from "~/server/api/root";
import { inventoryCSVRow, type InventoryCSVRow } from "~/schemas/inventory";

const readCSV = (fileName: string): InventoryCSVRow[] => {
  const file = fs.readFileSync(fileName, "utf8");
  const result = Papa.parse<Record<string, string>>(file, {
    header: true,
    skipEmptyLines: true,
    transformHeader: (header) =>
      header.toLowerCase().trim().replace(/\s+/g, "_"),
  });

  if (result.errors.length > 0) {
    console.error("CSV parse errors:", result.errors);
    throw new Error("Failed to parse CSV file");
  }

  // Transform and validate each row
  const rows: InventoryCSVRow[] = [];
  for (const row of result.data) {
    const parsed = inventoryCSVRow.safeParse({
      product_name: row.product_name || row.product || row.name,
      manufacturer: row.manufacturer || undefined,
      upc: row.upc || row.barcode || undefined,
      model: row.model || undefined,
      ndb_number: row.ndb_number || row.ndbnumber || undefined,
      location_path: row.location_path || row.location || undefined,
      quantity: row.quantity || row.qty || 1,
      unit: row.unit || "each",
      expected_qty: row.expected_qty || row.expectedqty || undefined,
      price: row.price || undefined,
      unit_mappings: row.unit_mappings || row.unitmappings || undefined,
      ingredient_name: row.ingredient_name || undefined,
      ingredient: row.ingredient,
      aliases: row.aliases || undefined,
    });

    if (!parsed.success) {
      console.error(`Row validation error:`, row, parsed.error);
      throw new Error(`Failed to validate CSV row`);
    }
    rows.push(parsed.data);
  }

  return rows;
};

// Configure CLI options with env var fallbacks
program
  .name("load-data")
  .description("Load configuration data from CSV into the database")
  .requiredOption(
    "--organization-id <id>",
    "Organization ID (UUID) or slug (e.g., 'acme-corp')",
    process.env.ORGANIZATION_ID || process.env.PROJECT_ID,
  )
  .requiredOption(
    "--api-key <key>",
    "Better-Auth API key for authentication",
    process.env.API_KEY,
  )
  .option("--file <path>", "Path to CSV file", "config.csv")
  .option("--seed-recipes", "Also seed sample recipes after import", false);

program.parse();

const options = program.opts<{
  organizationId: string;
  apiKey: string;
  file: string;
  seedRecipes: boolean;
}>();

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "http://localhost:3000/api/trpc",
      transformer: SuperJSON,
      headers: () => {
        return {
          "x-api-key": options.apiKey,
          "x-organization-id": options.organizationId,
        };
      },
    }),
  ],
});

console.log(`Loading data from ${options.file}...`);
const rows = readCSV(options.file);
console.log(`Parsed ${rows.length} rows from CSV`);

const result = await client.inventoryItem.importCSV.mutate({ rows });
console.log(`Import complete:
  - Created: ${result.created}
  - Moved: ${result.moved}
  - Updated: ${result.updated}
  - Product only: ${result.productOnly}
  - Skipped: ${result.skipped}
  - Errors: ${result.errors}`);

if (result.errors > 0) {
  const errorItems = result.items.filter((item) => item.action === "error");
  console.error("Error details:", errorItems);
}

if (options.seedRecipes) {
  console.log("Seeding recipes...");
  await client.recipe.seed.mutate();
  console.log("Recipes seeded.");
}
