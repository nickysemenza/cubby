import { z } from "zod";

/**
 * Server push is a doorbell: one socket per topic that only says "something
 * changed". Clients read the actual state through ordinary operations, so a
 * missed ring costs latency, never correctness.
 */
export const DOORBELL_PATH = "/api/doorbell";

export const doorbellTopic = z.enum([
  /** Household records changed; `categories` names the ripple keys to refetch. */
  "household.changed",
  /** Image-processing work may be claimable; the companion calls `imageProcessing.pull`. */
  "imageProcessing.work",
]);
export type DoorbellTopic = z.infer<typeof doorbellTopic>;

export const doorbellRing = z.object({
  type: z.literal("ring"),
  topic: doorbellTopic,
  /** A refetch hint; absent means the subscriber rereads everything it shows. */
  categories: z.array(z.string().min(1)).max(256).optional(),
});
export type DoorbellRing = z.infer<typeof doorbellRing>;

export const doorbellUrl = (topic: DoorbellTopic, origin: string): URL => {
  const url = new URL(DOORBELL_PATH, origin);
  url.searchParams.set("topic", topic);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url;
};
