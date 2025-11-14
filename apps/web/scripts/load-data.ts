import { createTRPCClient, httpBatchLink } from "@trpc/client";
import { program } from "commander";
import fs from "fs";
import SuperJSON from "superjson";
import YAML from "yaml";
import { type AppRouter } from "~/server/api/root";
import { configSchema } from "~/schemas/config";

const readConfig = (fileName: string) => {
  const file = fs.readFileSync(fileName, "utf8");
  const parsed = YAML.parse(file) as unknown;
  return configSchema.parse(parsed);
};

// Configure CLI options with env var fallbacks
program
  .name("load-data")
  .description("Load configuration data into the database")
  .requiredOption(
    "--organization-id <id>",
    "Organization ID (UUID) or slug (e.g., 'acme-corp')",
    process.env.ORGANIZATION_ID || process.env.PROJECT_ID,
  )
  .requiredOption(
    "--api-key <key>",
    "Better-Auth API key for authentication",
    process.env.API_KEY,
  );

program.parse();

const options = program.opts<{
  organizationId: string;
  apiKey: string;
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

const config = readConfig("config.yaml");
await client.system.loadConfig.mutate(config);
await client.recipe.seed.mutate();
