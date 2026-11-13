import { z } from "zod";
import { entitySchema } from "../entity-core";
import {
  edgeRoleSchema,
  operationDispositionSchema,
} from "../entity-integrity";

const text = z.string().min(1);
const column = z
  .templateLiteral([text, ".", text])
  .refine(
    (value) => /^[A-Z][A-Za-z0-9_]*\.[a-z][A-Za-z0-9_]*$/.test(value),
    "Expected Table.column",
  );
const endpoint = z.union([
  entitySchema,
  z.templateLiteral([z.literal("row:"), text]),
  z.literal("identity"),
]);
const liveness = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("must-target-live") }),
  z.strictObject({ kind: z.literal("allow-target-deleted"), reason: text }),
]);
const semantics = z.strictObject({
  role: edgeRoleSchema,
  label: text,
  description: text,
  liveness,
});
const policyReference = z.strictObject({
  module: text,
  export: text.regex(
    /^[A-Za-z_$][A-Za-z0-9_$]*$/,
    "Expected an exported function name",
  ),
});
export type EdgePolicyReference = z.infer<typeof policyReference>;

const operationPolicy = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("disposition"),
    disposition: operationDispositionSchema,
    /** Null means the ordinary disposition executor; custom policy names a function. */
    handler: policyReference.nullable(),
  }),
  z.strictObject({ kind: z.literal("unsupported"), reason: text }),
]);
const endpointPolicies = z.strictObject({
  delete: operationPolicy,
  merge: operationPolicy,
});
const ownership = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("entity"), entity: entitySchema }),
  z.strictObject({ kind: z.literal("column"), column }),
  z.strictObject({ kind: z.literal("identity"), column }),
  z.strictObject({ kind: z.literal("link-from"), column }),
  z.strictObject({
    kind: z.literal("via"),
    column,
    table: text,
    owner: column,
  }),
  z.strictObject({ kind: z.literal("excluded"), reason: text }),
]);
const collision = z.enum([
  "dropLoser",
  "dedupeEqualQuantityElseRefuse",
  "sumQuantity",
]);
const physicalStorage = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("foreign-key"),
    column,
    constrained: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("link"),
    linkKind: text,
    quantity: z.boolean(),
    forbidSelfLink: z.boolean(),
    acyclic: z.boolean(),
    onMergeCollision: z.strictObject({ from: collision, to: collision }),
  }),
]);
const cardinality = z.enum(["one", "many"]);
const identity = {
  key: text,
  from: endpoint,
  to: endpoint,
  cardinality,
  inverse: z.strictObject({
    key: text,
    from: endpoint,
    to: endpoint,
    cardinality,
  }),
};
const physical = z.strictObject({
  ...identity,
  storage: physicalStorage,
  ownership,
  fromEnd: semantics,
  toEnd: semantics,
  policies: z.strictObject({ from: endpointPolicies, to: endpointPolicies }),
});
const pathStep = z.strictObject({
  edge: text,
  direction: z.enum(["outgoing", "incoming"]),
});
const composition = z.strictObject({
  ...identity,
  storage: z.strictObject({
    kind: z.literal("composition"),
    sources: z
      .array(
        z.strictObject({
          key: text,
          label: text,
          path: z.array(pathStep).nonempty(),
        }),
      )
      .nonempty(),
  }),
  /** Compositions read their physical sources and introduce no second lifecycle policy. */
  ownership: z.strictObject({ kind: z.literal("sources") }),
  policies: z.strictObject({ kind: z.literal("sources") }),
});

export const edgeDefinitionSchema = z.union([physical, composition]);
export type EdgeDefinition = z.infer<typeof edgeDefinitionSchema>;

/** A module registers these values directly in its `edges` array. */
export const defineEdge = <const D extends EdgeDefinition>(
  declaration: D & {
    inverse: {
      from: NoInfer<D["to"]>;
      to: NoInfer<D["from"]>;
    };
  },
): D => {
  edgeDefinitionSchema.parse(declaration);
  if (
    declaration.inverse.from !== declaration.to ||
    declaration.inverse.to !== declaration.from
  )
    throw new Error(`${declaration.key}: inverse must reverse the endpoints.`);
  return declaration;
};
