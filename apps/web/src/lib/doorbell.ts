import { z } from "zod";

/**
 * Server push is a doorbell: one socket per topic that only says "something
 * changed". Clients read the actual state through ordinary operations, so a
 * missed ring costs latency, never correctness.
 */
export const DOORBELL_PATH = "/api/doorbell";

export const doorbellTopic = z.enum([
  /** Household records changed; `changes` names changed records by ripple key. */
  "household.changed",
  /** Image-processing work may be claimable; the companion calls `imageProcessing.pull`. */
  "imageProcessing.work",
]);
export type DoorbellTopic = z.infer<typeof doorbellTopic>;

/** Public record shortcodes, or null when the entire category may have changed. */
const databaseChanges = z.record(
  z.string().min(1),
  z.array(z.string().min(1)).max(200).nullable(),
);
export type DatabaseChanges = z.infer<typeof databaseChanges>;

/** Savepoint and notification batches use the same bounded, null-absorbing union. */
export function mergeDatabaseChanges(
  target: DatabaseChanges,
  incoming: DatabaseChanges,
): void {
  for (const [category, ids] of Object.entries(incoming)) {
    const previous = target[category];
    if (previous === null || ids === null) target[category] = null;
    else {
      const merged = [...new Set([...(previous ?? []), ...ids])];
      target[category] = merged.length > 200 ? null : merged;
    }
  }
}

export const doorbellRing = z.object({
  type: z.literal("ring"),
  topic: doorbellTopic,
  /** A refetch hint; absent means the subscriber rereads everything it shows. */
  changes: databaseChanges.optional(),
});
export type DoorbellRing = z.infer<typeof doorbellRing>;

export const doorbellUrl = (topic: DoorbellTopic, origin: string): URL => {
  const url = new URL(DOORBELL_PATH, origin);
  url.searchParams.set("topic", topic);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
};
