import { z } from "zod";

import { entityGraphRootSchema } from "./entity-graph";
import { entitySchema } from "./entity";

export const connectedRecordsInputSchema = z.object({
  source: entityGraphRootSchema,
  /** A curated view key, or `relation:<manifest key>` for an existing table. */
  viewKey: z.string().min(1),
  /** Restrict path evidence to the rows in an existing relation table. */
  targetIds: z.array(z.string().min(1)).max(50).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20),
});
export type ConnectedRecordsInput = z.input<typeof connectedRecordsInputSchema>;

export const connectedPathNodeSchema = z.object({
  entityKind: entitySchema,
  entityId: z.string(),
  label: z.string(),
});
export type ConnectedPathNode = z.infer<typeof connectedPathNodeSchema>;

export const connectedRecordSchema = z.object({
  target: connectedPathNodeSchema,
  /** Every distinct witnessed route, shortest first. Includes source and target. */
  paths: z.array(z.array(connectedPathNodeSchema).min(2)).min(1),
  shortestHops: z.number().int().positive(),
});
export const connectedRecordsOutputSchema = z.object({
  targetEntity: entitySchema,
  totalCount: z.number().int().nonnegative(),
  items: z.array(connectedRecordSchema),
});
export type ConnectedRecordsOutput = z.infer<
  typeof connectedRecordsOutputSchema
>;

export const connectedRecordsPreviewInputSchema = z.object({
  source: entityGraphRootSchema,
  /** Rows per view; each view also reports its complete count. */
  limit: z.number().int().min(1).max(10).default(3),
});
export type ConnectedRecordsPreviewInput = z.input<
  typeof connectedRecordsPreviewInputSchema
>;

/** Every curated connected view of one record in manifest order, first rows only. */
export const connectedRecordsPreviewOutputSchema = z.object({
  views: z.array(
    connectedRecordsOutputSchema.extend({
      viewKey: z.string(),
      title: z.string(),
    }),
  ),
});
export type ConnectedRecordsPreviewOutput = z.infer<
  typeof connectedRecordsPreviewOutputSchema
>;
