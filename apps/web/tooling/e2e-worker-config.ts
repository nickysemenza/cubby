import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** Keep the built Worker and local bindings; omit remote-only AI and background consumers. */
export function writeLocalWorkerdConfig(webRoot: string): void {
  const source = path.join(webRoot, "dist/server/wrangler.json");
  if (!existsSync(source))
    throw new Error("Build the web Cloudflare bundle before starting workerd");
  const config = z
    .object({
      ai: z.json().optional(),
      vectorize: z.json().optional(),
      queues: z
        .object({ consumers: z.array(z.json()).optional() })
        .loose()
        .optional(),
    })
    .loose()
    .parse(JSON.parse(readFileSync(source, "utf8")));
  delete config.ai;
  delete config.vectorize;
  if (config.queues) config.queues.consumers = [];
  writeFileSync(
    path.join(webRoot, "dist/server/wrangler.e2e.json"),
    JSON.stringify(config),
  );
}
