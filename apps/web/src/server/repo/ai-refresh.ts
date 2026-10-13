import {
  aiRefreshActivation,
  type AiRefreshManifest,
} from "@cubby/schemas/ai-evaluation";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { compiledRefreshManifest } from "~/server/ai/refresh-policy";
import type { Database } from "~/server/db";
import { appSettings } from "~/server/db/schema";

import { getDb, withTransactionDatabase } from "./database-helpers";

// Infrastructure identity, independent of the hourly app-open catch-up claim.
const SETTINGS_ID = "00000000-0000-4000-8000-000000000074";
export async function readAiRefreshActivation(
  db: Database,
  lock: false | "share" | "update" = false,
) {
  const query = getDb(db)
    .select({ metadata: appSettings.metadata })
    .from(appSettings)
    .where(eq(appSettings.id, SETTINGS_ID));
  const [row] = await (lock ? query.for(lock) : query);
  const parsed = aiRefreshActivation.safeParse(row?.metadata);
  return parsed.success ? parsed.data : null;
}

export async function activateAiRefresh(
  db: Database,
  release: string,
  options: { enabled: boolean; manifest?: AiRefreshManifest },
) {
  const compiled = options.manifest ?? (await compiledRefreshManifest());
  return withTransactionDatabase(db, async (tx) => {
    await getDb(tx)
      .insert(appSettings)
      .values({ id: SETTINGS_ID, metadata: {} })
      .onConflictDoNothing();
    const [row] = await getDb(tx)
      .select()
      .from(appSettings)
      .where(eq(appSettings.id, SETTINGS_ID))
      .for("update");
    const prior = aiRefreshActivation.safeParse(row?.metadata);
    const manifest: AiRefreshManifest = {};
    for (const [feature, next] of Object.entries(compiled)) {
      const old = prior.success ? prior.data.manifest[feature] : undefined;
      const same =
        old?.promptVersion === next.promptVersion &&
        old.policyFingerprint === next.policyFingerprint;
      manifest[feature] = {
        ...next,
        generation: same ? old.generation : (old?.generation ?? 0) + 1,
      };
    }
    const activation = aiRefreshActivation.parse({
      release,
      enabled: options.enabled,
      manifest,
      activatedAt:
        prior.success && prior.data.release === release
          ? prior.data.activatedAt
          : new Date().toISOString(),
    });
    await getDb(tx)
      .update(appSettings)
      .set({ metadata: activation, updatedAt: new Date() })
      .where(eq(appSettings.id, SETTINGS_ID));
    return activation;
  });
}

/** Attribute ordinary decisions to the executable policy, even during deployment overlap. */
export async function producingAiManifest(db: Database) {
  const [compiled, activation] = await Promise.all([
    compiledRefreshManifest(),
    readAiRefreshActivation(db),
  ]);
  return Object.fromEntries(
    Object.entries(compiled).map(([feature, policy]) => {
      const active = activation?.manifest[feature];
      return [
        feature,
        {
          ...policy,
          generation:
            active?.promptVersion === policy.promptVersion &&
            active.policyFingerprint === policy.policyFingerprint
              ? active.generation
              : 0,
        },
      ];
    }),
  );
}

const DISCOVERY_SETTINGS_ID = "00000000-0000-4000-8000-000000000075";
const discoveryCursor = z.object({
  field: z
    .object({ entity: z.string(), recordId: z.uuid(), field: z.string() })
    .nullable()
    .default(null),
  email: z.uuid().nullable().default(null),
});
export async function readAiDiscoveryCursor(db: Database) {
  const [row] = await getDb(db)
    .select({ metadata: appSettings.metadata })
    .from(appSettings)
    .where(eq(appSettings.id, DISCOVERY_SETTINGS_ID));
  return discoveryCursor.parse(row?.metadata ?? {});
}
export async function saveAiDiscoveryCursor(
  db: Database,
  value: z.infer<typeof discoveryCursor>,
) {
  await getDb(db)
    .insert(appSettings)
    .values({ id: DISCOVERY_SETTINGS_ID, metadata: value })
    .onConflictDoUpdate({
      target: appSettings.id,
      set: { metadata: value, updatedAt: new Date() },
    });
}
