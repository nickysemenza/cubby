import { runEntityId } from "@cubby/schemas/identifiers";
import { eq } from "drizzle-orm";
import { z } from "zod";

import type { Database } from "~/server/db";
import {
  repositoryQueries as getDb,
  repositoryTransactionDatabase,
} from "~/server/db/repository-access.boundary";
import { appSettings } from "~/server/db/retained-tables";
import type { Fenced } from "~/server/generic/jobs/types";

import { admitConnectionDiscoveryPage } from "./connection-refresh";

// Random id: production holds the AI budget at …077 and a retired settings row at …076.
const CONNECTION_DISCOVERY_CURSOR_ID = "0553199e-d21b-4325-8c52-cfb28fc26a2f";
const cursorSchema = z.object({
  stopped: z.boolean().default(false),
  error: z.string().nullable().default(null),
  after: z.string().nullable().default(null),
  runId: runEntityId.nullable().default(null),
  nextAt: z.iso.datetime().nullable().default(null),
});

/** Serialize only the admission page, including its cursor and retained Run continuation. */
export async function connectionDiscoveryPage<T>(
  db: Database,
  work: (
    tx: Database,
    cursor: z.infer<typeof cursorSchema>,
    save: (cursor: z.infer<typeof cursorSchema>) => Promise<void>,
  ) => Promise<T>,
) {
  return repositoryTransactionDatabase(db, async (tx) => {
    await getDb(tx)
      .insert(appSettings)
      .values({ id: CONNECTION_DISCOVERY_CURSOR_ID, metadata: {} })
      .onConflictDoNothing();
    const [row] = await getDb(tx)
      .select({ metadata: appSettings.metadata })
      .from(appSettings)
      .where(eq(appSettings.id, CONNECTION_DISCOVERY_CURSOR_ID))
      .for("update");
    return work(tx, cursorSchema.parse(row?.metadata ?? {}), async (cursor) => {
      await getDb(tx)
        .update(appSettings)
        .set({ metadata: cursor, updatedAt: new Date() })
        .where(eq(appSettings.id, CONNECTION_DISCOVERY_CURSOR_ID));
    });
  });
}

export const prepareConnectionDiscoveryPage = (
  fenced: Fenced,
  input: Parameters<typeof admitConnectionDiscoveryPage>[1],
) => fenced((tx) => admitConnectionDiscoveryPage(tx, input));
