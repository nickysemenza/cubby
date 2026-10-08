import { z } from "zod";
import { externalIdKind } from "./external-id";
import { purchaseShortcode, vendorShortcode } from "./identifier-fields";
import {
  extractedOrderCandidate,
  preparedProductResolution,
} from "./purchase-import";
import {
  acceptedResearchFact,
  researchClaimSupport,
  retainedEvidenceId,
} from "./research";
import { tradeSchema } from "./task-fields";

const workRef = z.uuid();
const reasoning = z.string().trim().min(1).max(8_000);
const evidenceIds = z.array(retainedEvidenceId).max(100);
const primaryEvidenceIds = evidenceIds.describe(
  "Retained evidence IDs authorized for this task's primary source. Related context sources can inform identity reasoning, but cannot authorize orders or email-link writes for another primary task.",
);
const observationRef = {
  observationId: z.uuid(),
  ref: z.string().min(1).max(100),
};
const [existingProduct, newProduct, unresolvedProduct, expenseOnly] =
  preparedProductResolution.options;
const indexedLine = { lineIndex: z.number().int().nonnegative() };
/** Researchers reuse public Product references returned by Cubby search. */
export const researchProductResolution = z.discriminatedUnion("kind", [
  existingProduct.extend(indexedLine).strict(),
  newProduct.extend(indexedLine).strict(),
  unresolvedProduct.extend(indexedLine).strict(),
  expenseOnly.extend(indexedLine).strict(),
]);
export const researchWorkNext = z.strictObject({});
export const researchWorkObserve = z.strictObject({
  workRef,
  action: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("navigate"), url: z.url().max(2_048) }),
    z.strictObject({ kind: z.literal("read") }),
    z.strictObject({ kind: z.literal("click"), ...observationRef }),
    z.strictObject({
      kind: z.literal("type"),
      ...observationRef,
      text: z.string().max(2_000),
      submit: z.boolean().default(false),
    }),
    z.strictObject({
      kind: z.literal("select"),
      ...observationRef,
      optionRef: z.string().min(1).max(100),
    }),
    z.strictObject({
      kind: z.literal("scroll"),
      direction: z.enum(["up", "down"]),
    }),
  ]),
});
const retainedCandidate = z.strictObject({
  candidateRef: z.uuid(),
  evidenceIds,
  support: researchClaimSupport,
});
export const researchWorkResolve = z.strictObject({
  workRef,
  status: z
    .enum([
      "verified",
      "partially_verified",
      "researched_with_gaps",
      "ambiguous",
      "temporarily_blocked",
      "no_source_found",
      "unrelated",
    ])
    .describe(
      "Outcome of the assigned task. A mail task can be verified when its supported order or lifecycle event is committed and linked, while the Purchase still has unknown payment, delivery or catalog facts. Product verification requires the requested identity coverage.",
    ),
  identity: z.strictObject({ evidenceIds: evidenceIds.default([]), reasoning }),
  facts: z.array(acceptedResearchFact).max(100).default([]),
  identifierClaims: z
    .array(
      z.strictObject({
        evidenceId: retainedEvidenceId,
        kind: externalIdKind,
        externalId: z.string().trim().min(1).max(500),
        support: researchClaimSupport,
      }),
    )
    .max(100)
    .default([]),
  identifierCandidates: z.array(retainedCandidate).max(100).default([]),
  imageCandidates: z.array(retainedCandidate).max(100).default([]),
  orders: z
    .array(
      z.strictObject({
        vendorRef: vendorShortcode.optional(),
        vendor: z
          .strictObject({
            name: z.string().trim().min(1).max(300),
            website: z.url().optional(),
          })
          .optional(),
        purchaseRef: purchaseShortcode.optional(),
        evidenceIds: primaryEvidenceIds,
        reasoning,
        candidate: extractedOrderCandidate,
        productResolutions: z
          .array(researchProductResolution)
          .max(500)
          .optional(),
        defaultTrade: tradeSchema,
      }),
    )
    .max(100)
    .default([]),
  emailLinks: z
    .array(
      z.strictObject({
        purchaseRef: purchaseShortcode,
        evidenceIds: primaryEvidenceIds,
        reasoning,
        event: z.enum([
          "confirmation",
          "shipped",
          "delivered",
          "cancelled",
          "refunded",
          "other",
        ]),
      }),
    )
    .max(100)
    .default([]),
  progress: z
    .strictObject({
      scopeExhausted: z.boolean(),
      evidenceIds,
      gaps: z.array(z.string().trim().min(1).max(2_000)).max(50),
    })
    .optional()
    .describe(
      "Scope coverage for an assigned frozen account-history or explicit backfill objective. Omit for an individual mail or Product task; one source does not establish broader scope exhaustion.",
    ),
  detail: z.string().trim().min(1).max(8_000),
});
export const researchMailSearch = z.strictObject({
  workRef,
  query: z.string().trim().min(1).max(2_000),
  mailboxRef: z.uuid().optional(),
  continuationRef: z.uuid().optional(),
});
export const researchMailRead = z.strictObject({
  workRef,
  messageRef: z
    .string()
    .min(1)
    .max(500)
    .describe(
      "A mail acquisition selector from assigned sources or mail search. Pass it to mail_read; cite the returned evidenceId in resolutions, never this messageRef.",
    ),
  attachmentRef: z.uuid().optional(),
});
export const RESEARCH_ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
/** Original bytes are a host result; models select only an issued reference. */
export const researchAttachmentOriginal = z.strictObject({
  attachmentRef: z.uuid(),
  filename: z.string().max(1_000),
  mimeType: z.string().regex(/^(?:application\/pdf|image\/[A-Za-z0-9.+-]+)$/u),
  checksum: z.string().regex(/^[a-f0-9]{64}$/u),
  dataBase64: z.string().max(Math.ceil(RESEARCH_ATTACHMENT_MAX_BYTES / 3) * 4),
});
export type ResearchAttachmentOriginal = z.infer<
  typeof researchAttachmentOriginal
>;
export const researchWebSearch = z.strictObject({
  workRef,
  query: z.string().trim().min(1).max(1_024),
});
export const researchWebRead = z.strictObject({
  workRef,
  url: z.url().max(2_048),
});
export const researchFind = z.strictObject({
  workRef,
  query: z.string().trim().min(1).max(100),
});
export const researchToolInputs = {
  work_next: researchWorkNext,
  work_observe: researchWorkObserve,
  work_resolve: researchWorkResolve,
  mail_search: researchMailSearch,
  mail_read: researchMailRead,
  web_search: researchWebSearch,
  web_read: researchWebRead,
  cubby_find: researchFind,
};
export type ResearchWorkNextInput = z.input<typeof researchWorkNext>;
export type ResearchWorkObserveInput = z.input<typeof researchWorkObserve>;
export type ResearchWorkResolveInput = z.input<typeof researchWorkResolve>;
export type ResearchWorkResolution = z.output<typeof researchWorkResolve>;
export type ResearchMailSearchInput = z.input<typeof researchMailSearch>;
export type ResearchMailReadInput = z.input<typeof researchMailRead>;
export type ResearchWebSearchInput = z.input<typeof researchWebSearch>;
export type ResearchWebReadInput = z.input<typeof researchWebRead>;
export type ResearchFindInput = z.input<typeof researchFind>;
