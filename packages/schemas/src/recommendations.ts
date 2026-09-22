import { z } from "zod";
import {
  inventoryShortcode,
  ledgerPartyShortcode,
  locationShortcode,
  productShortcode,
  purchaseShortcode,
} from "./identifiers";
import { duplicateProductIdentitySchema } from "./problems";
import { embeddingReadinessSchema, relatednessOutSchema } from "./relatedness";

export const recommendationWorkbenchInput = z.object({
  sourceId: productShortcode,
});

export const recommendationKind = z.enum([
  "product-related",
  "duplicate-product",
  "product-match",
  "tag-propagation",
  "placement",
]);
export type RecommendationKind = z.infer<typeof recommendationKind>;

/** Only an entity shortcode is permitted in the workbench URL. */
export const recommendationWorkbenchSearch = z
  .object({
    kind: recommendationKind.optional(),
    source: productShortcode.optional(),
    inventory: inventoryShortcode.optional(),
  })
  .strict();

export const dismissProductRecommendationInput = z.object({
  sourceId: productShortcode,
  targetId: productShortcode,
});

export const recommendationOkSchema = z.object({ ok: z.literal(true) });

export const recommendationWorkbenchOut = relatednessOutSchema;

export const duplicateProductRecommendationInput = z.object({
  sourceId: productShortcode,
});
export const duplicateProductRecommendationOut =
  duplicateProductIdentitySchema.nullable();
export const dismissDuplicateProductRecommendationInput = z.object({
  sourceId: productShortcode,
});

export const tagPropagationRecommendationInput = z.object({
  sourceId: productShortcode,
});
export const dismissTagPropagationInput = z.object({
  sourceId: productShortcode,
  tag: z.string().min(1),
});
export const tagPropagationRecommendationOut = z.object({
  status: embeddingReadinessSchema,
  currentTags: z.array(z.string()),
  proposals: z.array(
    z.object({
      tag: z.string(),
      supportingProductCount: z.number().int().positive(),
    }),
  ),
});
export type TagPropagationRecommendationOut = z.infer<
  typeof tagPropagationRecommendationOut
>;

export const placementRecommendationInput = z.object({
  inventoryId: inventoryShortcode,
});
export const placementRecommendationOut = z
  .object({
    inventoryId: inventoryShortcode,
    productName: z.string(),
    sourceLocation: z.object({ id: locationShortcode, name: z.string() }),
    destination: z.object({ id: locationShortcode, name: z.string() }),
  })
  .nullable();

/**
 * Two Products for one real item, as a single unordered pair. Order is the
 * caller's; the pair is the identity.
 */
export const productMatchPair = z
  .array(productShortcode)
  .length(2)
  .refine(([a, b]) => a !== b, {
    message: "A product match needs two different products",
  });

export const productMatchSource = z.enum(["agent", "detector"]);
export const productMatchState = z.enum(["open", "dismissed"]);

/**
 * `photo`: stocked, with no purchase line or spend yet (typically created from
 * a photo). `purchase`: on a purchase, with no live stock (typically created by
 * a purchase import). `other`: anything an agent paired that is neither.
 */
export const productMatchSideRole = z.enum(["photo", "purchase", "other"]);

export const productMatchOwner = z.object({
  id: ledgerPartyShortcode,
  name: z.string(),
});

export const productMatchSourceUrls = z.array(z.url()).max(10);

export const productMatchSide = z.object({
  id: productShortcode,
  name: z.string(),
  role: productMatchSideRole,
  category: z.string().nullable(),
  inventoryCount: z.number().int().nonnegative(),
  owner: productMatchOwner
    .nullable()
    .describe(
      "Explicit stock owner for a photo product; purchase-inherited owner for a purchase product; null when undeterminable",
    ),
  purchase: z
    .object({
      id: purchaseShortcode,
      date: z.string(),
      vendor: z.string().nullable(),
      line: z.string().nullable(),
    })
    .nullable(),
  gtins: z.array(z.string()),
  sources: z.array(z.string()),
});
export type ProductMatchSide = z.infer<typeof productMatchSide>;

export const productMatchCandidate = z.object({
  source: productMatchSource,
  /** Merge survivor by default: the purchase side carries the spend history. */
  keeper: productMatchSide,
  other: productMatchSide,
  evidence: z.string().nullable(),
  sourceUrls: z.array(z.string()),
  signals: z.array(z.string()),
  /** Things to fix before merging, e.g. both sides stocked (merge sums them). */
  warnings: z.array(z.string()),
});
export type ProductMatchCandidate = z.infer<typeof productMatchCandidate>;

export const productMatchQueueInput = z.object({
  productId: productShortcode.optional(),
});
export const productMatchQueueOut = z.object({
  /** False when the vector index is unreachable: ranking fell back to names. */
  semanticRanking: z.boolean(),
  items: z.array(productMatchCandidate),
});
export type ProductMatchQueueOut = z.infer<typeof productMatchQueueOut>;

export const dismissProductMatchInput = z.object({
  productIds: productMatchPair,
});

/** Merge `mergeId` into `keepId`, then lead the survivor's covers with own photos. */
export const mergeProductMatchInput = z.object({
  keepId: productShortcode,
  mergeId: productShortcode,
});

export const proposeProductMatchInput = z.object({
  productIds: productMatchPair.describe(
    "The two Product shortcodes (PRD-) believed to be the same real item, in either order",
  ),
  evidence: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe(
      "Why these are one item — what you compared (photo vs vendor page, size, colour, order line). Shown verbatim to the reviewer.",
    ),
  sourceUrls: productMatchSourceUrls
    .optional()
    .describe("Pages the evidence came from, e.g. the vendor product page"),
});
export const proposeProductMatchOut = z.object({
  productIds: z.array(productShortcode),
  source: productMatchSource,
  state: productMatchState,
  evidence: z.string().nullable(),
  sourceUrls: z.array(z.string()),
  created: z.boolean(),
});
