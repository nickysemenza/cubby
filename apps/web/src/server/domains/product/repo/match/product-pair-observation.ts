import { productId } from "@cubby/schemas/identifiers";
import { sql } from "drizzle-orm";
import { z } from "zod";

export const productPairObservation = z.object({
  productPair: z.string(),
  productIds: z.tuple([productId, productId]),
  data: z.object({
    otherId: productId,
    source: z.enum(["agent", "detector"]),
    evidence: z.string().nullable(),
    sourceUrls: z.array(z.string()),
    signals: z.json().optional(),
    actionable: z.boolean(),
    conflict: z.boolean(),
  }),
  fingerprint: z.string().nullable(),
  producer: z.json().nullable(),
});

/** Immutable pair evidence retains paid variant findings independently of the review queue. */
export const productPairObservationsSql = sql`(
 SELECT id, payload->>'productPair' AS "pairKey", payload->'productIds'->>0 AS "recordId",
   payload->'data' AS data, payload->'data' AS evidence, payload->'producer' AS producer,
   payload->>'fingerprint' AS fingerprint, "createdAt"
 FROM "ProductIdentityObservation"
)`;
