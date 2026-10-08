import { z } from "zod";
import { externalIdKind, externalIdSource } from "./external-id";
import {
  browserActionableControl,
  browserCapturedImage,
  browserCapturedLink,
  browserEvidenceReference,
  browserStructuredProducts,
} from "./purchase-import";

/** Source metadata is supplied by acquisition, never by a fact proposal. */
export const researchSourceMetadata = z.strictObject({
  sourceURL: z.url().nullish(),
  servedURL: z.url().optional(),
  requestedURL: z.url().optional(),
  title: z.string().optional(),
  capturedAt: z.iso.datetime().optional(),
  researchUploadState: z.enum(["pending", "uploaded"]).optional(),
  truncated: z.boolean().default(false),
  observationId: z.uuid().optional(),
  actions: z.array(browserActionableControl).max(500).default([]),
  actionsTruncated: z.boolean().default(false),
  screenshots: z.array(browserEvidenceReference).max(4).default([]),
  mailboxId: z.string().max(500).optional(),
  messageId: z.string().max(500).optional(),
  orderMailId: z.uuid().optional(),
  imageId: z.uuid().optional(),
  originalChecksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  originalEvidenceId: z.uuid().optional(),
  attachmentRef: z.uuid().optional(),
  attachmentChecksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  brokerAccountId: z.uuid().optional(),
  contextOnly: z.boolean().optional(),
  checksum: z
    .string()
    .regex(/^[a-f0-9]{64}$/u)
    .optional(),
  sender: z.string().max(1_000).optional(),
  subject: z.string().max(1_000).optional(),
  receivedAt: z.iso.datetime().optional(),
});
export type ResearchSourceMetadata = z.infer<typeof researchSourceMetadata>;

export const researchObservation = z.object({
  sourceURL: z.url().nullable(),
  servedURL: z.url().nullable(),
  canonicalUrl: z.url().nullable(),
  title: z.string().max(500),
  capturedAt: z.iso.datetime(),
  readableText: z.string().max(24 * 1_024),
  textTruncated: z.boolean(),
  truncated: z.boolean(),
  variantMarkers: z.array(z.string().max(500)).max(50),
  observationId: z.uuid().nullable(),
  actions: z.array(browserActionableControl).max(500),
  actionsTruncated: z.boolean(),
  links: z.array(browserCapturedLink).max(200),
  authenticationRequired: z.boolean(),
  structuredProducts: browserStructuredProducts.nullable(),
});
export type ResearchObservation = z.infer<typeof researchObservation>;

export const researchIdentifierCandidate = z.object({
  candidateRef: z.uuid(),
  evidenceId: z.uuid(),
  kind: externalIdKind,
  /** Null until the canonical identifier owner is resolved by the server. */
  source: externalIdSource.nullable(),
  sourceURL: z.url(),
  externalId: z.string().min(1).max(100),
  origin: z.enum(["json_ld", "visible", "selected_variant"]),
});
export type ResearchIdentifierCandidate = z.infer<
  typeof researchIdentifierCandidate
>;

export const researchImageCandidate = browserCapturedImage.extend({
  candidateRef: z.uuid(),
  evidenceId: z.uuid(),
  sourceURL: z.url(),
});
export type ResearchImageCandidate = z.infer<typeof researchImageCandidate>;

export const retainedResearchObservation = z.object({
  evidenceId: z.uuid(),
  observation: researchObservation,
  identifierCandidates: z.array(researchIdentifierCandidate).max(800),
  imageCandidates: z.array(researchImageCandidate).max(200),
});
export type RetainedResearchObservation = z.infer<
  typeof retainedResearchObservation
>;

export {
  researchClaimSupport,
  acceptedResearchFact,
  type ResearchClaimSupport,
  type AcceptedResearchFact,
} from "./research-facts";
