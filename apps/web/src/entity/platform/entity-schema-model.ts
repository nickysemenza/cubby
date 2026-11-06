import type { Entity } from "@cubby/schemas/entity";
import type {
  EntityInspectorMetadata,
  EntityDescriptor,
  photoCategories,
} from "@cubby/schemas/entity-manifest";

import type { entityOverrideComparisons } from "~/entity/generated/entity-override-comparisons.gen";

type Relationship = EntityDescriptor["relationships"][number];
export type OverrideComparison =
  (typeof entityOverrideComparisons)[Entity][number];
export type OverrideRow = OverrideComparison & { entity: Entity };

/** Technical presentation contracts select canonical compiler facts, rather than
 * importing a server implementation to infer the browser's response type. */
export type SchemaRow = Pick<
  EntityInspectorMetadata,
  "domain" | "mcpOwner" | "mcpOperations"
> & {
  entity: Entity;
  code: string | null;
  legacy: string | null;
  table: string | null;
  countable: boolean;
  crud: Record<"create" | "read" | "update" | "delete", boolean>;
  extras: EntityInspectorMetadata["kernelActions"];
  search: "semantic" | "lexical" | null;
  external: boolean;
  one: number;
  many: number;
  tables: Record<"declared" | "derived" | "omitted", number>;
  filters: number;
  idFilters: number;
  deleteMode:
    | NonNullable<EntityInspectorMetadata["lifecycle"]["delete"]>["mode"]
    | null;
  merge: EntityInspectorMetadata["lifecycle"]["merge"];
  overrides: number;
  sections: number;
  native: string | null;
  nativeHandoffs: string | null;
  rows?: number;
};
export type SchemaOverview = {
  rows: SchemaRow[];
  totals: Record<
    "declared" | "crud" | "search" | "mcp" | "ports" | "overrides",
    number
  >;
  graph: {
    entity: Entity;
    abbreviation: string;
    relationships: (Pick<Relationship, "key" | "target" | "cardinality"> & {
      detail: RelationDetail;
    })[];
  }[];
  photos: Pick<
    (typeof photoCategories)[keyof typeof photoCategories],
    "key" | "emoji" | "label" | "entities" | "classifierLabels"
  >[];
};
export type SchemaEntity = {
  row: SchemaRow;
  description: EntityInspectorMetadata["description"];
  repository: EntityInspectorMetadata["ports"]["repository"];
  detail: {
    variant: EntityInspectorMetadata["detail"]["variant"];
    sections: Pick<
      EntityInspectorMetadata["detail"]["sections"][number],
      "id" | "kind" | "title" | "placement"
    >[];
  };
  filters: Pick<
    EntityInspectorMetadata["filterDescriptors"][number],
    "urlKey" | "kind" | "field" | "label"
  >[];
  savedViews: Pick<
    EntityInspectorMetadata["list"]["savedViews"][number],
    "label"
  >[];
  relationships: (Pick<
    Relationship,
    "key" | "target" | "cardinality" | "derived" | "label"
  > & { detail: RelationDetail })[];
  overrides: readonly OverrideComparison[];
};

type KernelAction = EntityInspectorMetadata["kernelActions"][number];

/** The four CRUD slots; `read` needs both `get` and `list`. Anything else a
 * kernel declares (`search`, `bulkUpdate`, `merge`, `resolve`) is an extra. */
export const CRUD_SLOTS = [
  { key: "create", code: "C", needs: ["create"] },
  { key: "read", code: "R", needs: ["get", "list"] },
  { key: "update", code: "U", needs: ["update"] },
  { key: "delete", code: "D", needs: ["delete"] },
] as const satisfies readonly {
  key: string;
  code: string;
  needs: readonly KernelAction[];
}[];
type RelationDetailStatus =
  | "declared"
  | "derived"
  | "omitted"
  | "custom-list"
  | "no-list"
  | "one";

export const DETAIL_STATUS_LABEL = {
  declared: "declared",
  derived: "derived",
  omitted: "omitted",
  "custom-list": "custom list",
  "no-list": "no list",
  one: "—",
} satisfies Record<RelationDetailStatus, string>;

export type RelationDetail = {
  status: RelationDetailStatus;
  reason?: string;
  descriptor?: string;
};

export function relationStatusClass(status: RelationDetailStatus): string {
  switch (status) {
    case "declared":
      return "text-foreground";
    case "derived":
      return "text-primary";
    case "omitted":
      return "text-destructive";
    case "custom-list":
    case "no-list":
      return "text-muted-foreground/50";
    case "one":
      return "text-muted-foreground/30";
  }
}

export const RELATION_STATUS_LEGEND: readonly [RelationDetailStatus, string][] =
  [
    ["declared", "declared detail table"],
    ["derived", "compiler-derived detail table"],
    ["omitted", "explicitly omitted"],
    ["custom-list", "custom list; no inline relation table"],
    ["no-list", "target has no list page"],
    ["one", "one-cardinality (no table)"],
  ];
