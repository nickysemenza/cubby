import type { EdgeDefinition } from "@cubby/schemas/entity-definitions/edges";
import { generatedHeader, rawSource } from "../../artifacts.ts";
import type { EntityArtifacts } from "../declarations.ts";
const catalogModule =
  'import type { Entity } from "./entity-core";\nimport type { EdgeLiveness, EdgeRole } from "./entity-integrity";\n\n/**\n * Every many-to-many relationship between two entities lives in one generic\n * `EntityLink` table (ADR 0007). A link kind declares its two endpoint entity\n * kinds, whether it carries a quantity, and the stable meaning of each end as\n * seen from the entity at that end. The generator derives the table\'s CHECKs\n * (allowed endpoint kinds per link kind, quantity only where declared, no\n * self-link where forbidden), the physical edge graph entries, and the merge\n * repoint behavior from this map; nothing else hand-lists link kinds.\n *\n * Direction: `from` is the owning side (the row that owns the link\n * in `ENTITY_EDGE_OWNERS`) \u2014 the kit, the blocked task, the order.\n */\n\n/**\n * What a merge does when repointing the loser\'s links collides with a live\n * link the survivor already has for the same (kind, other end).\n *\n * - `dropLoser`: soft-delete the loser\'s duplicate link.\n * - `dedupeEqualQuantityElseRefuse`: drop it when both quantities match,\n *   otherwise refuse the merge rather than invent or destroy units.\n * - `sumQuantity`: add the loser\'s quantity onto the survivor\'s link.\n */\ntype LinkMergeCollision =\n  | "dropLoser"\n  | "dedupeEqualQuantityElseRefuse"\n  | "sumQuantity";\n\ninterface LinkEndSemantics {\n  /** The meaning of this link as an incoming edge of the entity at this end. */\n  readonly role: EdgeRole;\n  readonly label: string;\n  readonly description: string;\n  readonly liveness: EdgeLiveness;\n  /** How a merge of the entity AT THIS END resolves a collision. */\n  readonly onMergeCollision: LinkMergeCollision;\n}\n\nexport interface EntityLinkKindDeclaration {\n  readonly from: Entity;\n  readonly to: Entity;\n  /** A positive integer quantity is required on every link of this kind. */\n  readonly quantity: boolean;\n  /** `from = to` on one row is refused (and dropped when a merge would create it). */\n  readonly forbidSelfLink: boolean;\n  /** The write path refuses a link that would close a cycle of this kind. */\n  readonly acyclic: boolean;\n  readonly fromEnd: LinkEndSemantics;\n  readonly toEnd: LinkEndSemantics;\n}\n\nexport const ENTITY_LINK_KINDS = __CATALOG__ as const satisfies Record<string, EntityLinkKindDeclaration>;\n\nexport type EntityLinkKind = keyof typeof ENTITY_LINK_KINDS;\n\nexport const entityLinkKinds: readonly EntityLinkKind[] =\n  // SAFETY: Object.keys of a const literal returns exactly its declared keys.\n  Object.keys(ENTITY_LINK_KINDS) as EntityLinkKind[];\n\nexport type EntityLinkEnd = "from" | "to";\n\n/** The stable edge key naming one end of a link kind, e.g. `EntityLink[productComponent].from`. */\nexport type EntityLinkEdgeKey =\n  `EntityLink[${EntityLinkKind}].${EntityLinkEnd}`;\n\nexport const entityLinkEdgeKey = (\n  kind: EntityLinkKind,\n  end: EntityLinkEnd,\n): EntityLinkEdgeKey => `EntityLink[${kind}].${end}`;\n';
export const renderLinkCatalog = (
  edges: readonly EdgeDefinition[],
): EntityArtifacts => {
  const kinds = Object.fromEntries(
    edges.flatMap((edge) =>
      edge.storage.kind === "link" && "fromEnd" in edge
        ? [
            [
              edge.storage.linkKind,
              {
                from: edge.from,
                to: edge.to,
                quantity: edge.storage.quantity,
                forbidSelfLink: edge.storage.forbidSelfLink,
                acyclic: edge.storage.acyclic,
                fromEnd: {
                  ...edge.fromEnd,
                  onMergeCollision: edge.storage.onMergeCollision.from,
                },
                toEnd: {
                  ...edge.toEnd,
                  onMergeCollision: edge.storage.onMergeCollision.to,
                },
              },
            ],
          ]
        : [],
    ),
  );
  return {
    relativePath: "packages/schemas/src/entity-link-catalog.gen.ts",
    source: rawSource(
      generatedHeader +
        catalogModule.replace("__CATALOG__", JSON.stringify(kinds, null, 2)),
    ),
  };
};
