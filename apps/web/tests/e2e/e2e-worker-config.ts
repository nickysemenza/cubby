import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const webRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

/** Prepare the compiled Worker for isolated local harnesses. */
export function prepareE2EWranglerConfig(): void {
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

  // Local AI and Vectorize bindings can report configured but cannot serve
  // requests. The harness also has no queue delivery owner.
  delete e2eConfig.ai;
  delete e2eConfig.vectorize;
  if (e2eConfig.queues) e2eConfig.queues.consumers = [];
  writeFileSync(
    path.join(webRoot, "dist/server/wrangler.e2e.json"),
    JSON.stringify(e2eConfig),
  );
}
