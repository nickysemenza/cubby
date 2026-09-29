import type { RelationMutationOut } from "@cubby/schemas/common";
import type { ActorContext } from "@cubby/schemas/context";
import {
  ENTITY_LINK_KINDS,
  type EntityLinkKind,
} from "@cubby/schemas/entity-links";
import { type EntityId, parseEntityId } from "@cubby/schemas/identifiers";

import type { Database, DrizzleClient } from "~/server/db";
import { getDb } from "~/server/repo/database-helpers";
import {
  planRelationAttach,
  planRelationDetach,
  type RelationPlan,
  type RelationPreflight,
} from "~/server/repo/relation-preflight";
import {
  resolveAllOrThrow,
  resolveOrThrow,
} from "~/server/repo/shortcode-resolver";

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

type LinkFrom<K extends EntityLinkKind> = (typeof ENTITY_LINK_KINDS)[K]["from"];
type LinkTo<K extends EntityLinkKind> = (typeof ENTITY_LINK_KINDS)[K]["to"];

/**
 * What a link kind's relation owns beyond the shared shell: its rows, the
 * preflight its mutation refuses on, and the audited writes. Ids arrive
 * resolved to the link's declared endpoint entities.
 */
export interface LinkRelationSpec<
  K extends EntityLinkKind,
  TItem extends { id: string },
  TRow,
> {
  /** Short noun phrase naming the link rows in a plan ("kit components"). */
  label: string;
  /** What an attach / a detach would do, for the advisory plan. */
  describe: { attach: string; detach: string };
  list: (db: Database, ownerId: EntityId<LinkFrom<K>>) => Promise<TRow[]>;
  preflight: {
    attach?: (
      dbc: DrizzleClient,
      ownerId: EntityId<LinkFrom<K>>,
      targetIds: readonly EntityId<LinkTo<K>>[],
    ) => Promise<RelationPreflight>;
    detach: (
      dbc: DrizzleClient,
      ownerId: EntityId<LinkFrom<K>>,
      targetIds: readonly EntityId<LinkTo<K>>[],
    ) => Promise<RelationPreflight>;
  };
  /** An attach plan richer than its preflight (project tool timelines). */
  previewAttach?: (
    db: Database,
    ownerId: EntityId<LinkFrom<K>>,
    targetIds: readonly EntityId<LinkTo<K>>[],
  ) => Promise<RelationPlan>;
  attach: (
    db: Database,
    ownerId: EntityId<LinkFrom<K>>,
    targets: readonly { id: EntityId<LinkTo<K>>; item: TItem }[],
    actor: ActorContext,
  ) => Promise<RelationMutationOut>;
  detach: (
    db: Database,
    ownerId: EntityId<LinkFrom<K>>,
    targetIds: EntityId<LinkTo<K>>[],
    actor: ActorContext,
  ) => Promise<RelationMutationOut>;
}

/**
 * The kernel relation adapter for one `EntityLink` kind: public ids resolve
 * to the kind's declared `from`/`to` entities, the advisory preview projects
 * the SAME preflight the mutation refuses on (on the pooled client, outside
 * any transaction), and attach/detach dispatch to the kind's audited writes.
 */
export const linkRelationAdapter = <
  K extends EntityLinkKind,
  TItem extends { id: string },
  TRow,
>(
  kind: K,
  spec: LinkRelationSpec<K, TItem, TRow>,
): EntityRelationMutationAdapter<TItem, TRow> => {
  const declaration = ENTITY_LINK_KINDS[kind];
  // SAFETY: indexing the literal map by `kind: K` yields exactly K's
  // declared endpoints; TypeScript widens the lookup to every kind's union.
  const from = declaration.from as LinkFrom<K>;
  // SAFETY: as above, for the `to` endpoint.
  const to = declaration.to as LinkTo<K>;
  const edge = { edgeKey: `EntityLink[${kind}].to`, label: spec.label };
  const resolveOwner = async (db: Database, shortcode: string) =>
    parseEntityId(from, await resolveOrThrow(db, from, shortcode));
  return {
    async list(db, ownerShortcode) {
      return spec.list(db, await resolveOwner(db, ownerShortcode));
    },
    async preview(db, action, ownerId, targetIds) {
      const owner = parseEntityId(from, ownerId);
      const targets = targetIds.map((id) => parseEntityId(to, id));
      if (action === "attach") {
        if (spec.previewAttach) return spec.previewAttach(db, owner, targets);
        if (!spec.preflight.attach)
          throw new Error(`${kind} declares no attach preflight`);
        return planRelationAttach(
          await spec.preflight.attach(getDb(db), owner, targets),
          { ...edge, description: spec.describe.attach },
        );
      }
      return planRelationDetach(
        await spec.preflight.detach(getDb(db), owner, targets),
        { ...edge, description: spec.describe.detach },
      );
    },
    async execute(ctx, action, ownerShortcode, items) {
      const owner = await resolveOwner(ctx.db, ownerShortcode);
      const targetIds = await resolveAllOrThrow(
        ctx.db,
        to,
        items.map(({ id }) => id),
      );
      return action === "attach"
        ? spec.attach(
            ctx.db,
            owner,
            targetIds.map((id, index) => ({ id, item: items[index]! })),
            ctx.actorContext,
          )
        : spec.detach(ctx.db, owner, targetIds, ctx.actorContext);
    },
  };
};
