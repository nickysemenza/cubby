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
      headers: () => {
        const systemKey = process.env.SYSTEM_API_KEY;
        const projectId = process.env.PROJECT_ID;

        if (!systemKey) {
          throw new Error(
            "SYSTEM_API_KEY environment variable is required for load-data script",
          );
        }
        if (!projectId) {
          throw new Error(
            'PROJECT_ID environment variable is required for load-data script. Example: PROJECT_ID="88446b48-5885-4fbd-b378-2446af89a170"',
          );
        }

        return {
          "x-system-key": systemKey,
          "x-project-id": projectId,
        };
      },
    }),
  ],
});
const config = readConfig("config.yaml");
await client.system.loadConfig.mutate(config);
await client.recipe.seed.mutate();
