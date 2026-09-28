import type { Entity } from "./entity-core";
import type { EdgeLiveness, EdgeRole } from "./entity-integrity";

/**
 * Every many-to-many relationship between two entities lives in one generic
 * `EntityLink` table (ADR 0007). A link kind declares its two endpoint entity
 * kinds, whether it carries a quantity, and the stable meaning of each end as
 * seen from the entity at that end. The generator derives the table's CHECKs
 * (allowed endpoint kinds per link kind, quantity only where declared, no
 * self-link where forbidden), the physical edge graph entries, and the merge
 * repoint behavior from this map; nothing else hand-lists link kinds.
 *
 * Direction: `from` is the owning side (the row that used to own the join row
 * in `ENTITY_EDGE_OWNERS`) — the kit, the blocked task, the wish, the order.
 */

/**
 * What a merge does when repointing the loser's links collides with a live
 * link the survivor already has for the same (kind, other end).
 *
 * - `dropLoser`: soft-delete the loser's duplicate link.
 * - `dedupeEqualQuantityElseRefuse`: drop it when both quantities match,
 *   otherwise refuse the merge rather than invent or destroy units.
 * - `sumQuantity`: add the loser's quantity onto the survivor's link.
 */
export type LinkMergeCollision =
  | "dropLoser"
  | "dedupeEqualQuantityElseRefuse"
  | "sumQuantity";

export interface LinkEndSemantics {
  /** The meaning of this link as an incoming edge of the entity at this end. */
  readonly role: EdgeRole;
  readonly label: string;
  readonly description: string;
  readonly liveness: EdgeLiveness;
  /** How a merge of the entity AT THIS END resolves a collision. */
  readonly onMergeCollision: LinkMergeCollision;
}

export interface EntityLinkKindDeclaration {
  readonly from: Entity;
  readonly to: Entity;
  /** A positive integer quantity is required on every link of this kind. */
  readonly quantity: boolean;
  /** `from = to` on one row is refused (and dropped when a merge would create it). */
  readonly forbidSelfLink: boolean;
  /** The write path refuses a link that would close a cycle of this kind. */
  readonly acyclic: boolean;
  readonly fromEnd: LinkEndSemantics;
  readonly toEnd: LinkEndSemantics;
}

const MUST_TARGET_LIVE = { kind: "must-target-live" } as const;

export const ENTITY_LINK_KINDS = {
  wishCandidate: {
    from: "wish",
    to: "product",
    quantity: false,
    forbidSelfLink: false,
    acyclic: false,
    fromEnd: {
      role: "owned-child",
      label: "tool candidates",
      description:
        "An alternative tool Product belonging to this Wishlist entry; the pairing has no independent meaning once the Wish is removed.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
    toEnd: {
      role: "association",
      label: "wishlist candidates",
      description:
        "A tool Product considered as an alternative for a household Wishlist entry; it is planning data, not inventory or spend.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
  },
  purchaseProduct: {
    from: "purchase",
    to: "product",
    quantity: false,
    forbidSelfLink: false,
    acyclic: false,
    fromEnd: {
      role: "association",
      label: "products",
      description:
        "A Product this order bought. Carries no money — spend stays entirely on Expense — so this never doubles as a second ledger path.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
    toEnd: {
      role: "acquisition",
      label: "purchase links",
      description:
        "The vendor order this Product was bought on. Provenance, not money — it exists because an order paid in installments is an `allocation` whose Expenses can never carry a productId, leaving the goods with no path back to the order.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
  },
  projectTool: {
    from: "project",
    to: "product",
    quantity: false,
    forbidSelfLink: false,
    acyclic: false,
    fromEnd: {
      role: "association",
      label: "reusable resources",
      description:
        "A durable association recording a reusable tool or software Product used on this exact project.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
    toEnd: {
      role: "history",
      label: "project uses",
      description:
        "Durable history that this reusable tool or software Product was used on a household project; deleting the Product would leave that history nameless.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
  },
  gardenEntryPlanting: {
    from: "gardenEntry",
    to: "planting",
    quantity: false,
    forbidSelfLink: false,
    acyclic: false,
    fromEnd: {
      role: "history",
      label: "planting associations",
      description:
        "A live association records which growing attempts a garden entry describes.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
    toEnd: {
      role: "history",
      label: "garden entries",
      description:
        "Garden observations and harvests retain the planting they describe.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
  },
  productComponent: {
    from: "product",
    to: "product",
    quantity: true,
    forbidSelfLink: true,
    acyclic: true,
    fromEnd: {
      role: "composition",
      label: "kit components",
      description:
        "A row on this Product's own component list — what's inside it, when it's a kit or multi-pack. Deleting the kit takes its component list with it.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dedupeEqualQuantityElseRefuse",
    },
    toEnd: {
      role: "usage",
      label: "kits it's listed inside",
      description:
        "This Product cited as a part of another (kit) Product's component list, with its own quantity. The kit and the part remain independently real products; this only says the part is currently accounted for inside the kit.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "sumQuantity",
    },
  },
  taskDependency: {
    from: "task",
    to: "task",
    quantity: false,
    forbidSelfLink: true,
    acyclic: true,
    fromEnd: {
      role: "dependency",
      label: "blocked-by dependencies",
      description:
        "A dependency edge naming this task as the one blocked, waiting on another task to finish first.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
    toEnd: {
      role: "dependency",
      label: "blocking dependencies",
      description:
        "A dependency edge naming this task as the blocker another task is waiting on.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
  },
  projectDependency: {
    from: "project",
    to: "project",
    quantity: false,
    forbidSelfLink: true,
    acyclic: true,
    fromEnd: {
      role: "dependency",
      label: "blocked-by dependencies",
      description:
        "A dependency edge naming this project as the one blocked, waiting on another project to finish first.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
    toEnd: {
      role: "dependency",
      label: "blocking dependencies",
      description:
        "A dependency edge naming this project as the blocker another project is waiting on.",
      liveness: MUST_TARGET_LIVE,
      onMergeCollision: "dropLoser",
    },
  },
} as const satisfies Record<string, EntityLinkKindDeclaration>;

export type EntityLinkKind = keyof typeof ENTITY_LINK_KINDS;

export const entityLinkKinds: readonly EntityLinkKind[] =
  // SAFETY: Object.keys of a const literal returns exactly its declared keys.
  Object.keys(ENTITY_LINK_KINDS) as EntityLinkKind[];

export type EntityLinkEnd = "from" | "to";

/** The stable edge key naming one end of a link kind, e.g. `EntityLink[productComponent].from`. */
export type EntityLinkEdgeKey =
  `EntityLink[${EntityLinkKind}].${EntityLinkEnd}`;

export const entityLinkEdgeKey = (
  kind: EntityLinkKind,
  end: EntityLinkEnd,
): EntityLinkEdgeKey => `EntityLink[${kind}].${end}`;
