import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { program } from "commander";
import fs from "fs";
import SuperJSON from "superjson";
import { type AppRouter } from "~/server/api/root";
import { parseInventoryCSV } from "~/lib/csv-utils";

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
const csvContent = fs.readFileSync(options.file, "utf8");
const rows = parseInventoryCSV(csvContent);
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
