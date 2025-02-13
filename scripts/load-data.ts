import { createTRPCClient, httpBatchLink } from "@trpc/client";
import fs from "fs";
import SuperJSON from "superjson";
import YAML from "yaml";
import { type AppRouter } from "~/server/api/root";
import { configSchema } from "~/schemas/config";
import { config } from "~/testdata/data-config";

if (false) {
  const file = fs.readFileSync("config.yaml", "utf8");
  const parsed = YAML.parse(file) as unknown;
  const config = configSchema.parse(parsed);
  console.log(JSON.stringify(config, null, 2));
}

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "http://localhost:3000/api/trpc",
      transformer: SuperJSON,
    }),
  ],
});
const loadCnofig = await client.system.loadConfig.mutate(config);
console.log({ loadCnofig });
const seed = await client.recipe.seed.mutate();
console.log({ seed });
