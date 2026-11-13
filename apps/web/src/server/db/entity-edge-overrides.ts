/** Explicit domain semantics override declaration-derived ordinary references. */
import type { Entity } from "@cubby/schemas/entity";
import type { EdgeLiveness, EdgeRole } from "@cubby/schemas/entity-integrity";
import {
  ENTITY_LINK_KINDS,
  entityLinkEdgeKey,
  type EntityLinkKind,
  type EntityLinkKindDeclaration,
  entityLinkKinds,
} from "@cubby/schemas/entity-links";
import { mapRecord } from "@cubby/shared";
import { ENTITY_KEYS } from "@cubby/shared/entity-keys";
import type { AnyColumn } from "drizzle-orm";

import { DECLARED_EDGE_OVERRIDES } from "./generated/declared-edges.gen";
import {
  shipment,
  entityAttachment,
  entityLink,
  expense,
  financialTransactionAllocation,
  importPreparedOrder,
  sourceOrderObservation,
  importSourceOrder,
  purchasePaymentEvidence,
} from "./schema";

/** `${pgTable name}.${column name}` — e.g. `"EntityAttachment.imageId"`. */
type EdgeKey<C extends AnyColumn> = `${C["_"]["tableName"]}.${C["_"]["name"]}`;

export interface EntityEdge {
  /** The FK column, on the referencing table, that points at this entity's `id`. */
  column: AnyColumn;
  /**
   * What the edge represents in the domain — never what an operation does
   * about it. See {@link EdgeRole} for the closed vocabulary.
   */
  role: EdgeRole;
  /** Plural noun phrase naming the referencing rows, e.g. "recipes". */
  label: string;
  /** One or two sentences explaining what the edge means and why. */
  description: string;
  /**
   * Whether a live source row is allowed to point at a soft-deleted target.
   * Nearly every edge is `must-target-live`.
   */
  liveness: EdgeLiveness;
  /**
   * True when the relationship is real (modeled in `relations()`, walked by
   * app code) but carries no DB-level FK constraint. Predicates that need to
   * walk the relationship still can; they just can't rely on the database to
   * enforce or cascade it.
   */
  unconstrained?: true;
  /** Free-text justification, for an edge whose key alone doesn't explain itself. */
  note?: string;
  /**
   * The rows of `column`'s table that belong to this edge, when the table
   * carries several edges in one column. Every `EntityLink` edge is scoped to
   * its link kind (`kind = 'productComponent'`): `toEntityId` alone would
   * match a product's purchase, tool, wish, and component links at once.
   * Every consumer that builds SQL from `column` must AND this in.
   */
  scope?: EdgeScope;
}

export interface EdgeScope {
  column: AnyColumn;
  value: string;
}

/**
 * Forces every entry's key to equal `EdgeKey<its own column>`. Drizzle
 * preserves a concretely-declared column's table name and column name as
 * literal string types (see `productImage.imageId`'s inferred type), so
 * key↔column correspondence is checkable even though completeness of the edge
 * SET is not — a mis-keyed entry (wrong table, wrong column, a typo) fails to
 * satisfy this and is a compile error at the `edges({...})` call site. Set
 * completeness is entity-manifest-fk.unit.test.ts's job, not this type's.
 */
type WellKeyed<T extends Record<string, EntityEdge>> = {
  [K in keyof T]: K extends EdgeKey<T[K]["column"]> ? unknown : never;
};

function edges<T extends Record<string, EntityEdge>>(t: T & WellKeyed<T>): T {
  return t;
}

type LinkDeclaration = typeof ENTITY_LINK_KINDS;

/**
 * The two incoming edges every link kind contributes, keyed by
 * `entityLinkEdgeKey`: `.from` is incoming at the owning entity, `.to` at the
 * other end. Each keeps its declaration's literal `role`, which
 * `PRODUCT_EDGE_ROLES` selects retaining edges by.
 */
type LinkEdgesOf<E extends Entity> = {
  [
    K in EntityLinkKind as LinkDeclaration[K]["from"] extends E
      ? `EntityLink[${K}].from`
      : never
  ]: Omit<EntityEdge, "role"> & {
    role: LinkDeclaration[K]["fromEnd"]["role"];
  };
} & {
  [
    K in EntityLinkKind as LinkDeclaration[K]["to"] extends E
      ? `EntityLink[${K}].to`
      : never
  ]: Omit<EntityEdge, "role"> & {
    role: LinkDeclaration[K]["toEnd"]["role"];
  };
};

function linkEdgesFor<E extends Entity>(entity: E): LinkEdgesOf<E> {
  const entries = entityLinkKinds.flatMap((kind) => {
    const declaration: EntityLinkKindDeclaration = ENTITY_LINK_KINDS[kind];
    const scope = { column: entityLink.kind, value: kind };
    const ends = [
      {
        end: "from",
        at: declaration.from,
        column: entityLink.fromEntityId,
        meaning: declaration.fromEnd,
      },
      {
        end: "to",
        at: declaration.to,
        column: entityLink.toEntityId,
        meaning: declaration.toEnd,
      },
    ] as const;
    return ends
      .filter((candidate) => candidate.at === entity)
      .map(
        ({ end, column, meaning }) =>
          [
            entityLinkEdgeKey(kind, end),
            {
              column,
              scope,
              role: meaning.role,
              label: meaning.label,
              description: meaning.description,
              liveness: meaning.liveness,
            } satisfies EntityEdge,
          ] as const,
      );
  });
  // SAFETY: the entries are exactly the ends whose endpoint kind is `entity`,
  // keyed and typed as `LinkEdgesOf<E>` spells out.
  return Object.fromEntries(entries) as LinkEdgesOf<E>;
}

export const ENTITY_EDGE_OVERRIDES = {
  // The generated vocabulary owns empty groups; explicit semantics retain literal edge keys.
  ...mapRecord(ENTITY_KEYS, () => ({})),

  purchase: {
    ...edges({
      "Shipment.purchaseId": {
        column: shipment.purchaseId,
        role: "reference",
        label: "shipments",
        description: "The package's currently accepted order association.",
        liveness: { kind: "must-target-live" },
      },
      "SourceOrderObservation.purchaseId": {
        column: sourceOrderObservation.purchaseId,
        role: "history",
        label: "source order observations",
        description:
          "The original Purchase subject of an immutable source extraction.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Immutable observation history retains its original subject UUID through deletion and merge.",
        },
      },
      "ImportPreparedOrder.targetPurchaseId": {
        column: importPreparedOrder.targetPurchaseId,
        role: "history",
        label: "prepared purchase targets",
        description:
          "The explicitly reviewed target captured during import preparation.",
        liveness: {
          kind: "allow-target-deleted",
          reason:
            "Preparation retains its original target tombstone. Deletion or merge invalidates commit and requires preparation against the current Purchase.",
        },
      },
      "ImportSourceOrder.purchaseId": {
        column: importSourceOrder.purchaseId,
        role: "history",
        label: "import source claims",
        description:
          "The accepted source order that produced this purchase and fences its replay. Deleting the purchase clears the link and keeps the row as the Email's accepted history.",
        liveness: { kind: "must-target-live" },
      },
      "PurchasePaymentEvidence.purchaseId": {
        column: purchasePaymentEvidence.purchaseId,
        role: "transaction",
        label: "payment evidence",
        description:
          "A captured shipment or order payment tied to this purchase.",
        liveness: { kind: "must-target-live" },
      },
      "Expense.purchaseId": {
        column: expense.purchaseId,
        role: "ledger",
        label: "expenses",
        description:
          "A categorized line of spend booked against this purchase. All money lives on Expense.cost; the purchase's own statedTotal is a soft reconciliation cue and is never summed into spend.",
        liveness: { kind: "must-target-live" },
      },
      "EntityAttachment.entityId": {
        column: entityAttachment.entityId,
        role: "media",
        label: "purchase documents",
        description:
          "A receipt, invoice, or other document attached to this purchase.",
        liveness: { kind: "must-target-live" },
      },
      "FinancialTransactionAllocation.purchaseId": {
        column: financialTransactionAllocation.purchaseId,
        role: "transaction",
        label: "settlement allocations",
        description:
          "A slice of one card or bank transaction attributed to this purchase. One real charge can settle several purchases, so the slice — not the whole transaction — is what this order settled. The amount is evidence only; spend remains SUM(Expense.cost).",
        liveness: { kind: "must-target-live" },
      },
    }),
    ...linkEdgesFor("purchase"),
  },

  // The read-only run record itself has no delete/merge operation
  // (`capabilities.delete: null`), so nothing here ever dispositions these
  // edges under a runTable operation — see entity-incoming-edges.ts's
  // doc comment. Child rows (target/mutation/operation/progress/
  // control-event/approval/prepared-order) exist only as part
  // of one run, so they're `owned-child`; rows other entities keep about a
  // run (purchases it touched, claims it advanced, findings it produced) are
  // `history`, mirroring vendorAccount's own edges above.

  ...DECLARED_EDGE_OVERRIDES,
} as const satisfies Record<Entity, Record<string, EntityEdge>>;
