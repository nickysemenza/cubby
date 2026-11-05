import {
  aiRefreshActivation,
  type AiRefreshManifest,
} from "@cubby/schemas/ai-evaluation";
import { eq } from "drizzle-orm";
import { z } from "zod";

import { compiledRefreshManifest } from "~/server/ai/policy/refresh-manifest";
import type { Database } from "~/server/db";
import { getDb, withTransactionDatabase } from "~/server/db/helpers";
import {
  appSettings,
  AI_REFRESH_ACTIVATION_SETTINGS_ID,
} from "~/server/db/schema";

// Infrastructure identity, independent of the hourly app-open catch-up claim.
const SETTINGS_ID = AI_REFRESH_ACTIVATION_SETTINGS_ID;
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
  options: {
    enabled: boolean;
    manifest?: AiRefreshManifest;
    startDiscovery?: boolean;
    observationEpoch?: number;
  },
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
    if (
      prior.success &&
      options.observationEpoch !== undefined &&
      prior.data.observationEpoch > options.observationEpoch
    )
      return prior.data;
    const manifest: AiRefreshManifest = {};
    let changed =
      !prior.success ||
      prior.data.enabled !== options.enabled ||
      Object.keys(prior.data.manifest).length !== Object.keys(compiled).length;
    for (const [feature, next] of Object.entries(compiled)) {
      const old = prior.success ? prior.data.manifest[feature] : undefined;
      const same =
        old?.promptVersion === next.promptVersion &&
        old.policyFingerprint === next.policyFingerprint;
      changed ||= !same;
      manifest[feature] = {
        ...next,
        generation: same ? old.generation : (old?.generation ?? 0) + 1,
      };
    }
    const activation = aiRefreshActivation.parse({
      release,
      observationEpoch:
        options.observationEpoch ??
        (prior.success ? prior.data.observationEpoch : 0),
      revision: (prior.success ? prior.data.revision : 0) + (changed ? 1 : 0),
      enabled: options.enabled,
      manifest,
      activatedAt:
        prior.success && prior.data.release === release
          ? prior.data.activatedAt
          : new Date().toISOString(),
    });
    let resetCursor = false;
    if (options.startDiscovery && options.enabled && changed)
      resetCursor = true;
    await getDb(tx)
      .update(appSettings)
      .set({ metadata: activation, updatedAt: new Date() })
      .where(eq(appSettings.id, SETTINGS_ID));
    if (resetCursor)
      await saveAiDiscoveryCursor(tx, {
        revision: activation.revision,
        field: null,
        email: null,
      });
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
  /** When this generation's pass finished; the next one starts an hour later. */
  completedAt: z.iso.datetime().nullable().default(null),
  revision: z.number().int().nonnegative().default(0),
  fieldDone: z.boolean().default(false),
  emailDone: z.boolean().default(false),
  productDone: z.boolean().default(false),
  connectionDone: z.boolean().default(false),
  connection: z.uuid().nullable().default(null),
  product: z.uuid().nullable().default(null),
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
  value: z.input<typeof discoveryCursor>,
) {
  return withTransactionDatabase(db, async (tx) => {
    // Every revision writer locks this row, serializing the check through the cursor write.
    const current = await readAiRefreshActivation(tx, "update");
    const cursor = discoveryCursor.parse({
      ...value,
      revision: value.revision ?? current?.revision ?? 0,
    });
    if (current && current.revision !== cursor.revision) return false;
    await getDb(tx)
      .insert(appSettings)
      .values({ id: DISCOVERY_SETTINGS_ID, metadata: cursor })
      .onConflictDoUpdate({
        target: appSettings.id,
        set: { metadata: cursor, updatedAt: new Date() },
      });
    return true;
  });
}

// Infrastructure observation, independent of the member's automatic-rule switch.
const DEPLOYMENT_SETTINGS_ID = "00000000-0000-4000-8000-000000000079";
const deploymentObservation = z.object({
  version: z.string(),
  occurrence: z.number().int().positive(),
});
/**
 * Activate once per observed deployment, in one transaction with its observation, so a
 * failure leaves it for the next cron tick. Returning to a version is a new occurrence.
 */
export async function admitAiRefreshDeployment(
  db: Database,
  version: string,
  release: string,
  currentVersion: () => Promise<string>,
) {
  return withTransactionDatabase(db, async (tx) => {
    await getDb(tx)
      .insert(appSettings)
      .values({ id: DEPLOYMENT_SETTINGS_ID, metadata: {} })
      .onConflictDoNothing();
    const [row] = await getDb(tx)
      .select()
      .from(appSettings)
      .where(eq(appSettings.id, DEPLOYMENT_SETTINGS_ID))
      .for("update");
    // Old cron invocations cannot install their version after replacement or rollback.
    if ((await currentVersion()) !== version) return null;
    const previous = deploymentObservation.safeParse(row?.metadata);
    if (previous.success && previous.data.version === version) return null;
    const active = await readAiRefreshActivation(tx);
    const observation = {
      version,
      occurrence:
        Math.max(
          previous.success ? previous.data.occurrence : 0,
          active?.observationEpoch ?? 0,
        ) + 1,
    };
    await getDb(tx)
      .update(appSettings)
      .set({ metadata: observation, updatedAt: new Date() })
      .where(eq(appSettings.id, DEPLOYMENT_SETTINGS_ID));
    return activateAiRefresh(tx, release, {
      enabled: true,
      startDiscovery: true,
      observationEpoch: observation.occurrence,
    });
  });
}
