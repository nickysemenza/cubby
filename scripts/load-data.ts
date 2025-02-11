import { createTRPCClient, httpBatchLink } from "@trpc/client";
import fs from "fs";
import SuperJSON from "superjson";
import YAML from "yaml";
import { type AppRouter } from "~/server/api/root";
import { configSchema } from "~/schemas/config";

const file = fs.readFileSync("config.yaml", "utf8");
const parsed = YAML.parse(file) as unknown;
const config = configSchema.parse(parsed);
console.log(config);

const client = createTRPCClient<AppRouter>({
  links: [
    httpBatchLink({
      url: "http://localhost:3000/api/trpc",
      transformer: SuperJSON,
    }),
  ],
});
const foo = await client.system.loadConfig.mutate(config);
console.log(foo);
