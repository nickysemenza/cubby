import { createTRPCClient, httpBatchLink } from "@trpc/client";
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

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "http://localhost:3000/api/trpc",
      transformer: SuperJSON,
    }),
  ],
});
const config = readConfig("config.yaml");
await client.system.loadConfig.mutate(config);
await client.recipe.seed.mutate();
