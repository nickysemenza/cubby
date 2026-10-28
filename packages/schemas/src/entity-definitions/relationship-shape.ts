import { z } from "zod";

const text = z.string().min(1);
export const relationshipEdgeKeySchema = z
  .string()
  .regex(
    /^(?:[A-Z][A-Za-z0-9_]*\.[a-z][A-Za-z0-9_]*|EntityLink\[[a-z][A-Za-z0-9]*\]\.(?:from|to))$/,
    "expected Table.column or EntityLink[kind].from|to",
  )
  .meta({ mockValue: "EntityAttachment.imageId" });
export const relationshipPathStepSchema = z.strictObject({
  edge: relationshipEdgeKeySchema,
  direction: z.enum(["outgoing", "incoming"]),
});
export const relationshipInverseSchema = z.strictObject({
  steps: z.array(relationshipPathStepSchema).min(1),
});
export const relationshipProvenanceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("local-path"),
    steps: z.array(relationshipPathStepSchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("query"),
    query: text,
    reverse: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("derived"),
    filter: text,
    evidence: z.array(text).min(1),
  }),
  z.strictObject({
    kind: z.literal("external"),
    system: text,
    sourceColumns: z.array(relationshipEdgeKeySchema).min(1),
  }),
  z.strictObject({
    kind: z.literal("unconstrained"),
    edge: relationshipEdgeKeySchema,
  }),
]);
export const entityRelationSourceMetadataSchema = z.strictObject({
  key: text,
  label: text,
  provenance: relationshipProvenanceSchema,
  inverse: relationshipInverseSchema.optional(),
});
const sourceRef = z.strictObject({ module: text, export: text });
/** Curated list presentation belongs to the relation whose records it displays. */
export const relationshipViewMetadataSchema = z.strictObject({
  /** Override only to preserve an established view ID when the relation key differs. */
  key: text.optional(),
  columnGroup: text.optional(),
  order: z.enum(["alphabetical", "newest", "task"]).optional(),
  defaultVisible: z.boolean().optional(),
  /** Override only to preserve established filter and saved-view field names. */
  filterPrefix: text.optional(),
  inverseKey: text.optional(),
  filter: z.boolean().optional(),
});
export const entityRelationMetadataSchema = z.strictObject({
  key: text,
  label: text,
  target: text,
  cardinality: z.enum(["one", "many"]),
  sourceKey: text.optional(),
  view: relationshipViewMetadataSchema.optional(),
  provenance: relationshipProvenanceSchema,
  inverse: relationshipInverseSchema.optional(),
  sources: z.array(entityRelationSourceMetadataSchema).optional(),
  derived: z.literal(true).optional(),
  inverseOmit: text.optional(),
  empty: text.optional(),
  list: z.strictObject({ rowSchema: sourceRef, adapter: sourceRef }).optional(),
  mutation: z
    .strictObject({
      source: text,
      itemSchema: sourceRef,
      rowSchema: sourceRef,
      adapter: sourceRef,
      audiences: z.array(z.enum(["browser", "mcp"])).min(1),
    })
    .optional(),
});
