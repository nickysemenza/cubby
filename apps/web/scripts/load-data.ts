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
    "--project-id <id>",
    "Project ID (UUID)",
    process.env.PROJECT_ID,
  )
  .requiredOption(
    "--system-key <key>",
    "System API key for authentication",
    process.env.SYSTEM_API_KEY,
  );

program.parse();

const options = program.opts<{
  projectId: string;
  systemKey: string;
}>();

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "http://localhost:3000/api/trpc",
      transformer: SuperJSON,
      headers: () => {
        return {
          "x-system-key": options.systemKey,
          "x-project-id": options.projectId,
        };
      },
    }),
  ],
});

const config = readConfig("config.yaml");
await client.system.loadConfig.mutate(config);
await client.recipe.seed.mutate();
