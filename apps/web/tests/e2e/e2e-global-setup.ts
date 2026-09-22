import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { prepareE2EDatabaseTemplate } from "./e2e-database";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Prepare immutable inputs before Playwright starts isolated worker runtimes. */
async function globalSetup(): Promise<void> {
  const webRoot = path.join(__dirname, "../..");
  const e2eConfig = z
    .object({
      compatibility_date: z.string(),
      ai: z.json().optional(),
      vectorize: z.json().optional(),
      queues: z
        .object({ consumers: z.array(z.json()).optional() })
        .loose()
        .optional(),
    })
    .loose()
    .parse(
      JSON.parse(
        readFileSync(path.join(webRoot, "dist/server/wrangler.json"), "utf8"),
      ),
    );

  // AI and Vectorize have no local binding (a local Vectorize stub exists but
  // throws "needs to be run remotely" on every call, which would make
  // `semanticEmbeddingsConfigured()` lie), and browser acceptance does not own
  // queue delivery.
  delete e2eConfig.ai;
  delete e2eConfig.vectorize;
  if (e2eConfig.queues) e2eConfig.queues.consumers = [];
  writeFileSync(
    path.join(webRoot, "dist/server/wrangler.e2e.json"),
    JSON.stringify(e2eConfig),
  );

  console.log("[E2E Setup] Preparing shared PostgreSQL template...");
  const templateStart = performance.now();
  await prepareE2EDatabaseTemplate();
  console.log(
    `[E2E Setup] Shared PostgreSQL template is ready ${Math.round(performance.now() - templateStart)}ms`,
  );
}

export default globalSetup;
