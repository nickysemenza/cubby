import type { RelationMutationOut } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";

import type { Database } from "~/server/db";
import type { RelationPlan } from "~/server/repo/relation-preflight";

interface EntityRelationMutationContext {
  db: Database;
  actorContext: ActorContext;
}

/** Repository-side seam used by generated entity relation bindings. */
export interface EntityRelationMutationAdapter<TItem, TRow> {
  /** The owner's current rows, read for the kernel `listRelation` action. */
  list(db: Database, ownerShortcode: string): Promise<TRow[]>;
  preview(
    db: Database,
    action: "attach" | "detach",
    ownerId: string,
    targetIds: readonly string[],
  ): Promise<RelationPlan>;
  execute(
    ctx: EntityRelationMutationContext,
    action: "attach" | "detach",
    ownerShortcode: string,
    items: readonly TItem[],
  ): Promise<RelationMutationOut>;
}
