import {
  suggestionChildHandle,
  suggestionReviewReference,
} from "./suggestion-reference";
import { z } from "zod";
import { ledgerPartyRefOut } from "./ledger-party-fields";
import { generatedPurchaseFieldSchemas } from "./generated/entity-field-schemas.purchase.gen";
import { productShortcode, purchaseShortcode } from "./identifiers";
import { relatednessOutSchema } from "./relatedness";
import { productVariantComparison } from "./product-variant-comparison";

export const recommendationOkSchema = z.object({ ok: z.literal(true) });

/** @public Names a generated native model. */
export const recommendationWorkbenchOut = relatednessOutSchema;

/**
 * Two Products for one real item, as a single unordered pair. Order is the
 * caller's; the pair is the identity.
 */
const productMatchPair = z
  .array(productShortcode)
  .length(2)
  .refine(([a, b]) => a !== b, {
    message: "A product match needs two different products",
  });

export const productMatchSource = z.enum(["agent", "detector"]);
const productMatchState = z.enum(["open", "dismissed"]);

/**
 * `photo`: stocked, with no purchase line or spend yet (typically created from
 * a photo). `purchase`: on a purchase, with no live stock (typically created by
 * a purchase import). `other`: anything an agent paired that is neither.
 */
export const productMatchSideRole = z.enum(["photo", "purchase", "other"]);

const productMatchOwner = ledgerPartyRefOut;

const productMatchSourceUrls = z.array(z.url()).max(10);

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
      date: generatedPurchaseFieldSchemas.read.date,
      vendor: z.string().nullable(),
      line: z.string().nullable(),
    })
    .nullable(),
  gtins: z.array(z.string()),
  sources: z.array(z.string()),
});
export type ProductMatchSide = z.infer<typeof productMatchSide>;

/** Shown wherever a pending pair lacks exact-identifier admission. */
export const PRODUCT_PAIR_NOT_ACTIONABLE =
  "Not actionable: no exact identifier binds both records; investigate before merging";

const productMatchCandidate = z.object({
  review: suggestionReviewReference.optional(),
  suggestionId: suggestionChildHandle,
  fingerprint: z.string().nullable(),
  identityConflict: z.boolean(),
  /** Raw stored values behind `identityConflict` (model or variant literals). */
  conflictReasons: z.array(z.string()),
  /** False without exact-identifier admission; merge stays available. */
  actionable: z.boolean(),
  source: productMatchSource,
  /**
   * Suggested merge survivor: the purchase side (it carries the spend
   * history), then the higher data-quality score, then the older record.
   */
  keeper: productMatchSide,
  other: productMatchSide,
  evidence: z.string().nullable(),
  sourceUrls: z.array(z.string()),
  signals: z.array(z.string()),
  /** Things to fix before merging, e.g. both sides stocked (merge sums them). */
  warnings: z.array(z.string()),
  /** Variant facts with retained evidence; unknown facts remain unknown. */
  variant: productVariantComparison,
});
export type ProductMatchCandidate = z.infer<typeof productMatchCandidate>;

const productMatchQueueOut = z.object({
  /** False when the vector index is unreachable: ranking fell back to names. */
  semanticRanking: z.boolean(),
  items: z.array(productMatchCandidate),
});
export type ProductMatchQueueOut = z.infer<typeof productMatchQueueOut>;

/**
 * Merge `mergeId` into `keepId`, then lead the survivor's covers with own photos.
 * @public Names a generated native model.
 */
export const mergeProductMatchInput = z.object({
  suggestionId: suggestionChildHandle,
  expectedFingerprint: z.string().min(1),
  keepId: productShortcode,
  mergeId: productShortcode,
});

const productMergeDecision = z.object({
  field: z.string(),
  keeper: z.string(),
  incoming: z.string(),
  result: z.string(),
  action: z.enum(["keep", "fill", "combine", "dedupe"]),
});
export const productMergePreview = z.object({
  decisions: z.array(productMergeDecision),
  blockers: z.array(z.string()),
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
