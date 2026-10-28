import { z } from "zod";
import {
  ENTITY_LINK_KINDS,
  entityLinkEdgeKey,
  type EntityLinkKind,
} from "../entity-links";

import {
  relationshipQueryDefinition,
  type RelationshipQueryKey,
  type RelationshipQuerySource,
  type RelationshipQueryTarget,
} from "../relationship-query-definitions";

import type {
  SourceRelationshipEdgeKey,
  ValidRelationshipPath,
  RelationshipEntityKey,
} from "./relationship-catalog";

import {
  entityRelationMetadataSchema,
  entityRelationSourceMetadataSchema,
  relationshipInverseSchema,
  relationshipProvenanceSchema,
} from "./relationship-shape";

type RelationshipEdge = SourceRelationshipEdgeKey;
export type RelationshipStep = {
  edge: RelationshipEdge;
  direction: "outgoing" | "incoming";
};
type Provenance = z.infer<typeof relationshipProvenanceSchema>;
type Inverse = z.infer<typeof relationshipInverseSchema>;
type Relation = z.infer<typeof entityRelationMetadataSchema>;
type NamedOptions = Omit<
  Relation,
  "key" | "label" | "target" | "cardinality" | "provenance"
>;
type Cardinality = "one" | "many";

export type RelationshipHandle<
  From extends string,
  To extends string,
  C extends Cardinality,
> = {
  readonly from: From;
  readonly target: To;
  readonly cardinality: C;
  readonly provenance: Provenance;
  named<const Key extends string, const Label extends string>(
    key: Key,
    label: Label,
    options?: NamedOptions,
  ): Relation & { key: Key; label: Label; target: To; cardinality: C };
  source(
    key: string,
    label: string,
  ): z.infer<typeof entityRelationSourceMetadataSchema>;
};
export type TraversableRelationshipHandle<
  From extends string,
  To extends string,
  C extends Cardinality,
> = RelationshipHandle<From, To, C> & {
  through<Next extends string>(
    next: TraversableRelationshipHandle<NoInfer<To>, Next, Cardinality>,
  ): TraversableRelationshipHandle<From, Next, "many">;
  inverse(): TraversableRelationshipHandle<To, From, "many">;
  inverse<IC extends Cardinality>(
    cardinality: IC,
  ): TraversableRelationshipHandle<To, From, IC>;
};
const handle = <F extends string, T extends string, C extends Cardinality>(
  from: F,
  target: T,
  cardinality: C,
  provenance: Provenance,
  inverse?: Inverse,
): RelationshipHandle<F, T, C> => ({
  from,
  target,
  cardinality,
  provenance,
  named: (key, label, options = {}) => ({
    key,
    label,
    target,
    cardinality,
    provenance,
    ...(inverse ? { inverse } : {}),
    ...options,
  }),
  source: (key, label) => ({
    key,
    label,
    provenance,
    ...(inverse ? { inverse } : {}),
  }),
});
const reverseSteps = (steps: Inverse["steps"]): Inverse["steps"] =>
  [...steps].reverse().map(({ edge, direction }) => ({
    edge,
    direction: direction === "outgoing" ? "incoming" : "outgoing",
  }));
const traversable = <F extends string, T extends string, C extends Cardinality>(
  from: F,
  target: T,
  cardinality: C,
  provenance: Extract<Provenance, { kind: "local-path" | "query" }>,
): TraversableRelationshipHandle<F, T, C> => {
  const steps =
    provenance.kind === "local-path"
      ? provenance.steps
      : [
          {
            edge: `Relationship.${provenance.query}`,
            direction: provenance.reverse
              ? ("incoming" as const)
              : ("outgoing" as const),
          },
        ];
  function inverse(): TraversableRelationshipHandle<T, F, "many">;
  function inverse<IC extends Cardinality>(
    value: IC,
  ): TraversableRelationshipHandle<T, F, IC>;
  function inverse(value: Cardinality = "many") {
    return traversable(
      target,
      from,
      value,
      provenance.kind === "local-path"
        ? { kind: "local-path", steps: reverseSteps(provenance.steps) }
        : { ...provenance, reverse: !provenance.reverse },
    );
  }
  return {
    ...handle(from, target, cardinality, provenance, {
      steps: reverseSteps(steps),
    }),
    inverse,
    through: (next) => {
      if (target !== next.from)
        throw new Error(
          `Cannot compose ${from} → ${target} with ${next.from} → ${next.target}.`,
        );
      const nextSteps =
        next.provenance.kind === "local-path"
          ? next.provenance.steps
          : next.provenance.kind === "query"
            ? [
                {
                  edge: `Relationship.${next.provenance.query}`,
                  direction: next.provenance.reverse
                    ? ("incoming" as const)
                    : ("outgoing" as const),
                },
              ]
            : [];
      if (nextSteps.length === 0)
        throw new Error("Only traversable relationships can be composed.");
      // A composed path identifies records, never an unambiguous write operation.
      return traversable(from, next.target, "many", {
        kind: "local-path",
        steps: [...steps, ...nextSteps],
      });
    },
  };
};

type Field = {
  readonly key: string;
  readonly kind?: string;
  readonly reference?: {
    readonly entity: string;
    readonly multiple?: boolean;
  } | null;
};
type Owner = {
  readonly key: string;
  readonly table: string | null;
  readonly storage?: object;
  readonly model?: {
    readonly fields: readonly Field[];
    readonly storage?: readonly (
      | string
      | { readonly key: string; readonly reference?: string | null }
    )[];
  };
};
type Fields<O extends Owner> = O extends {
  model: { fields: infer F extends readonly Field[] };
}
  ? F[number]
  : never;
type StoredModelKey<O extends Owner> = O extends {
  model: { storage: readonly (infer S)[] };
}
  ? S extends { reference: null }
    ? never
    : S extends string
      ? S
      : S extends { key: infer K extends string }
        ? K
        : never
  : never;
type StoredKey<O extends Owner> =
  | StoredModelKey<O>
  | (O extends {
      storage: { columns: readonly { key: infer K extends string }[] };
    }
      ? K
      : never);
type ReferenceField<O extends Owner> = Exclude<
  Extract<
    Fields<O>,
    { key: StoredKey<O>; kind: "identifier"; reference: { entity: string } }
  >,
  { reference: { multiple: true } }
>;
type Target<F> = F extends { reference: { entity: infer E extends string } }
  ? E
  : never;
type LinkDirection = "outgoing" | "incoming";
type LinkTarget<
  K extends EntityLinkKind,
  D extends LinkDirection,
> = D extends "outgoing"
  ? (typeof ENTITY_LINK_KINDS)[K]["to"]
  : (typeof ENTITY_LINK_KINDS)[K]["from"];
type LinkOwner<
  K extends EntityLinkKind,
  D extends LinkDirection,
> = D extends "outgoing"
  ? (typeof ENTITY_LINK_KINDS)[K]["from"]
  : (typeof ENTITY_LINK_KINDS)[K]["to"];

type QueryOrigin<
  K extends RelationshipQueryKey,
  Reverse extends boolean,
> = Reverse extends true
  ? RelationshipQueryTarget<K>
  : RelationshipQuerySource<K>;
type QueryDestination<
  K extends RelationshipQueryKey,
  Reverse extends boolean,
> = Reverse extends true
  ? RelationshipQuerySource<K>
  : RelationshipQueryTarget<K>;

/** Source-only relationship construction; the compiler validates physical paths against the complete catalog. */
export const createRelationships = <const O extends Owner>(owner: O) => ({
  field<const K extends ReferenceField<O>["key"]>(
    key: K,
  ): TraversableRelationshipHandle<
    O["key"],
    Target<Extract<ReferenceField<O>, { key: K }>>,
    "one"
  > {
    const field = owner.model?.fields.find(
      (candidate) => candidate.key === key,
    );
    const stored =
      owner.model?.storage?.some((column) =>
        typeof column === "string"
          ? column === key
          : column.key === key && column.reference !== null,
      ) ||
      z
        .object({ columns: z.array(z.object({ key: z.string() })).optional() })
        .parse(owner.storage ?? {})
        .columns?.some((column) => column.key === key);
    if (
      !stored ||
      !field?.reference ||
      field.kind !== "identifier" ||
      field.reference.multiple ||
      owner.table === null
    )
      throw new Error(
        `${owner.key}.${key} must be a singular stored reference field.`,
      );
    // SAFETY: the key is constrained to singular stored references; the lookup and guard above preserve that field's target.
    const target = field.reference.entity as Target<
      Extract<ReferenceField<O>, { key: K }>
    >;
    return traversable(owner.key, target, "one", {
      kind: "local-path",
      steps: [{ edge: `${owner.table}.${key}`, direction: "outgoing" }],
    });
  },
  link<const K extends EntityLinkKind, const D extends LinkDirection>(
    kind: K & (O["key"] extends LinkOwner<K, D> ? unknown : never),
    direction: D,
  ): TraversableRelationshipHandle<O["key"], LinkTarget<K, D>, "many"> {
    const declaration = ENTITY_LINK_KINDS[kind];
    const from = direction === "outgoing" ? declaration.from : declaration.to;
    if (from !== owner.key)
      throw new Error(`${kind} does not start at ${owner.key}.`);
    // SAFETY: the same direction selects the registry endpoint and its conditional type.
    const target = (
      direction === "outgoing" ? declaration.to : declaration.from
    ) as LinkTarget<K, D>;
    return traversable(owner.key, target, "many", {
      kind: "local-path",
      steps: [
        {
          edge: entityLinkEdgeKey(
            kind,
            direction === "outgoing" ? "from" : "to",
          ),
          direction: "incoming",
        },
        {
          edge: entityLinkEdgeKey(
            kind,
            direction === "outgoing" ? "to" : "from",
          ),
          direction: "outgoing",
        },
      ],
    });
  },
  path<
    const T extends RelationshipEntityKey,
    const C extends Cardinality,
    const Steps extends readonly [RelationshipStep, ...RelationshipStep[]],
  >(
    target: T,
    cardinality: C,
    steps: Steps & ValidRelationshipPath<Extract<O["table"], string>, T, Steps>,
  ) {
    return traversable(owner.key, target, cardinality, {
      kind: "local-path",
      steps: [...steps],
    });
  },
  query<
    const K extends RelationshipQueryKey,
    const C extends Cardinality,
    const Reverse extends boolean = false,
  >(
    query: K & (O["key"] extends QueryOrigin<K, Reverse> ? unknown : never),
    cardinality: C,
    reverse?: Reverse,
  ) {
    const definition = relationshipQueryDefinition(query);
    const source = reverse ? definition.target : definition.source;
    const destination = reverse ? definition.source : definition.target;
    if (source !== owner.key)
      throw new Error(`${query} does not start at ${owner.key}.`);
    // SAFETY: destination comes from this query's registry entry using the same reverse flag.
    const target = destination as QueryDestination<K, Reverse>;
    return traversable(owner.key, target, cardinality, {
      kind: "query",
      query,
      ...(reverse ? { reverse } : {}),
    });
  },
  derived<const T extends RelationshipEntityKey, const C extends Cardinality>(
    target: T,
    cardinality: C,
    filter: string,
    evidence: readonly [string, ...string[]],
  ) {
    return handle(owner.key, target, cardinality, {
      kind: "derived",
      filter,
      evidence: [...evidence],
    });
  },
  external<const T extends RelationshipEntityKey>(
    target: T,
    system: string,
    sourceColumns: readonly [string, ...string[]],
  ) {
    return handle(owner.key, target, "one", {
      kind: "external",
      system,
      sourceColumns: [...sourceColumns],
    });
  },
});
