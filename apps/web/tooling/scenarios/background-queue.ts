import { fromPartial } from "@total-typescript/shoehorn";
import { sql } from "drizzle-orm";
import { getBackgroundQueue, setCfEnv } from "~/server/cf-env";
import type { Database } from "~/server/db";
import { getDb } from "~/server/db/helpers";

/** Node scenario writers hand work to their running Worker, never execute handlers. */
export function installScenarioBackgroundQueue(
  db: Database,
  origin: string,
): void {
  if (getBackgroundQueue()) return;
  setCfEnv(
    fromPartial<Env>({
      BACKGROUND_QUEUE: {
        sendBatch: async (messages: Iterable<{ body: unknown }>) => {
          const url = new URL("/__dev/background-tasks", origin);
          if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
            throw new Error("Scenario background tasks require a local Worker");
          const rows = await getDb(db).execute<{ database: string }>(
            sql`SELECT current_database() AS database`,
          );
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              database: rows.rows[0]?.database,
              messages: [...messages].map(({ body }) => body),
            }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!response.ok)
            throw new Error(
              `Scenario background publication failed (${response.status}): ${await response.text()}`,
            );
        },
      },
    }),
  );
}
