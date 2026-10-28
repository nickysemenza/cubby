/** Type-only physical graph assembled from independently owned declaration bodies. */
import type { entityAttachmentStorage } from "../entity-attachment";
import type { imageAssociationStorage } from "./image-associations";
import type { ENTITY_LINK_KINDS } from "../entity-links";
import type { modulesChildren } from "../child-tables/modules";
import type {
  RelationshipQueryKey,
  RelationshipQuerySource,
  RelationshipQueryTarget,
} from "../relationship-query-definitions";
import type { EntityDefinitions as Definitions } from "./definition-catalog.gen";

export type RelationshipEntityKey = Definitions["key"];
type RelationshipEntityTable<K extends string> =
  Extract<Definitions, { key: K }> extends infer D
    ? D extends { table: infer T extends string }
      ? T
      : never
    : never;
type Edge<K extends string, F extends string, T extends string> = {
  key: K;
  from: F;
  to: T;
};
type ModelStorageKey<D> = D extends { model: { storage: readonly (infer S)[] } }
  ? S extends { reference: null }
    ? never
    : S extends string
      ? S
      : S extends { key: infer K extends string }
        ? K
        : never
  : never;
type StorageKey<D> =
  | ModelStorageKey<D>
  | (D extends {
      storage: { columns: readonly { key: infer K extends string }[] };
    }
      ? K
      : never);
type FieldEdges<D> = D extends {
  table: infer Table extends string;
  model: { fields: readonly (infer F)[] };
}
  ? F extends {
      key: infer Key extends StorageKey<D>;
      kind: "identifier";
      reference: { entity: infer Target extends string };
    }
    ? F extends { reference: { multiple: true } }
      ? never
      : Edge<`${Table}.${Key}`, Table, RelationshipEntityTable<Target>>
    : never
  : never;
type ExtraEdges<D> = D extends {
  table: infer Table extends string;
  storage: { columns: readonly (infer C)[] };
}
  ? C extends {
      key: infer Key extends string;
      reference: infer Target extends string;
    }
    ? Edge<`${Table}.${Key}`, Table, RelationshipEntityTable<Target>>
    : never
  : never;
type OwnedChildren<D> = D extends { children: readonly (infer C)[] }
  ? C
  : never;
type Children = OwnedChildren<Definitions> | (typeof modulesChildren)[number];
type ExportTable<D> = D extends { table: infer T extends string }
  ? { exportName: Uncapitalize<T>; name: T }
  : never;
type Tables = Children | ExportTable<Definitions>;
type TargetTable<Export extends string> =
  Extract<Tables, { exportName: Export }> extends infer T
    ? T extends { name: infer Name extends string }
      ? Name
      : never
    : never;
type ChildEdges<C> = C extends {
  name: infer Table extends string;
  columns: readonly (infer F)[];
}
  ? F extends {
      key: infer Key extends string;
      reference: { table: infer Target extends string };
    }
    ? Edge<`${Table}.${Key}`, Table, TargetTable<Target>>
    : never
  : never;
type LinkKinds = typeof ENTITY_LINK_KINDS;
type LinkEdges = {
  [K in keyof LinkKinds]:
    | Edge<
        `EntityLink[${K}].from`,
        `EntityLink[${K}]`,
        RelationshipEntityTable<LinkKinds[K]["from"]>
      >
    | Edge<
        `EntityLink[${K}].to`,
        `EntityLink[${K}]`,
        RelationshipEntityTable<LinkKinds[K]["to"]>
      >;
}[keyof LinkKinds];
type QueryEdges = {
  [K in RelationshipQueryKey]: Edge<
    `Relationship.${K}`,
    RelationshipEntityTable<RelationshipQuerySource<K>>,
    RelationshipEntityTable<RelationshipQueryTarget<K>>
  >;
}[RelationshipQueryKey];

type DeclaredForeignKeyEdges<C> = C extends {
  name: infer Table extends string;
  foreignKeys: readonly (infer FK)[];
}
  ? FK extends {
      columns: readonly (infer Key extends string)[];
      table: infer Target extends string;
    }
    ? Edge<`${Table}.${Key}`, Table, TargetTable<Target>>
    : never
  : never;
type Attachment = typeof entityAttachmentStorage;
type AttachmentOwner = keyof typeof imageAssociationStorage.shape;
type AttachmentEdges =
  | Edge<
      `${Attachment["table"]}.${Attachment["owner"]["column"]}`,
      Attachment["table"],
      RelationshipEntityTable<AttachmentOwner>
    >
  | Edge<
      `${Attachment["table"]}.${Attachment["image"]["column"]}`,
      Attachment["table"],
      RelationshipEntityTable<Attachment["image"]["targetEntity"]>
    >;

type SourceRelationshipEdge =
  | FieldEdges<Definitions>
  | ExtraEdges<Definitions>
  | ChildEdges<Children>
  | DeclaredForeignKeyEdges<Children>
  | LinkEdges
  | QueryEdges
  | AttachmentEdges;
export type SourceRelationshipEdgeKey = SourceRelationshipEdge["key"];
type Step = {
  readonly edge: SourceRelationshipEdgeKey;
  readonly direction: "incoming" | "outgoing";
};
type NextNode<
  Node extends string,
  S extends Step,
  E = Extract<SourceRelationshipEdge, { key: S["edge"] }>,
> =
  E extends Edge<string, infer From, infer To>
    ? S["direction"] extends "outgoing"
      ? Node extends From
        ? To
        : never
      : Node extends To
        ? From
        : never
    : never;
type Walk<
  Node extends string,
  Steps extends readonly Step[],
> = Steps extends readonly [
  infer First extends Step,
  ...infer Rest extends readonly Step[],
]
  ? Walk<NextNode<Node, First>, Rest>
  : Node;
/** Invalid edge, direction, adjacency or final entity contributes an uninhabitable argument. */
export type ValidRelationshipPath<
  From extends string,
  Target extends string,
  Steps extends readonly Step[],
> = [Walk<From, Steps>] extends [never]
  ? never
  : [RelationshipEntityTable<Target>] extends [never]
    ? never
    : RelationshipEntityTable<Target> extends Walk<From, Steps>
      ? unknown
      : never;
