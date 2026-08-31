import { entityRefKey } from "@cubby/schemas/entity";
import type {
  ImpactItem,
  PreviewOperation,
  PublicImpactItem,
} from "@cubby/schemas/entity-integrity";
import {
  previewOperationSchema,
  toPublicImpact,
} from "@cubby/schemas/entity-integrity";
import { parseEntityRef } from "@cubby/schemas/identifiers";

import type { Database } from "~/server/db";
import { previewGeneratedRelationMutation } from "~/server/generated/entity-relation-bindings.gen";
import {
  generatedEntityRelationItemIds,
  generatedEntityRelationTarget,
  type GeneratedEntityRelationCommand,
} from "~/server/generated/entity-relation-contracts.gen";
import {
  lookupShortcodes,
  resolveLiveShortcodes,
} from "~/server/repo/shortcode-resolver";

/**
 * Transport-neutral attach/detach preview dispatch. Each planner shares the mutation's
 * predicate, but mutations still re-check inside their own transaction.
 */
type Planned = {
  blockers: ImpactItem[];
  changes: ImpactItem[];
  sideEffects?: ImpactItem[];
};

const EMPTY_PLAN: Planned = { blockers: [], changes: [] };

const planRelation = async (
  db: Database,
  input: GeneratedEntityRelationCommand,
): Promise<{
  planned: Planned;
  publicIdByEntityId: Map<string, string>;
  unresolved?: string[];
}> => {
  const targetEntity = generatedEntityRelationTarget(input);
  const targetShortcodes = generatedEntityRelationItemIds(input);
  const [parentIds, productIds] = await Promise.all([
    resolveLiveShortcodes(db, [input.id], input.entity),
    resolveLiveShortcodes(db, targetShortcodes, targetEntity),
  ]);
  const unresolved = [
    ...(parentIds.has(input.id) ? [] : [input.id]),
    ...targetShortcodes.filter((code) => !productIds.has(code)),
  ];
  if (unresolved.length > 0) {
    return { planned: EMPTY_PLAN, publicIdByEntityId: new Map(), unresolved };
  }

  const parentId = parentIds.get(input.id)!;
  const targets = targetShortcodes.map((code) => productIds.get(code)!);
  const planned = await previewGeneratedRelationMutation(
    db,
    input,
    parentId,
    targets,
  );

  const codes = await lookupShortcodes(db, [
    parseEntityRef(input.entity, parentId),
    ...targets.map((id) => parseEntityRef(targetEntity, id)),
  ]);
  const publicIdByEntityId = new Map(
    [
      [input.entity, parentId] as const,
      ...targets.map((id) => [targetEntity, id] as const),
    ].flatMap(([entity, id]) => {
      const code = codes.get(entityRefKey(entity, id));
      return code ? [[id, code] as const] : [];
    }),
  );
  return { planned, publicIdByEntityId };
};

export const previewOperation = async (
  db: Database,
  input: GeneratedEntityRelationCommand,
  now: Date,
): Promise<PreviewOperation> => {
  const { planned, publicIdByEntityId, unresolved } = await planRelation(
    db,
    input,
  );
  return previewOperationSchema.parse({
    operation: input.action,
    entity: input.entity,
    relation: input.relation,
    targetCount: input.items.length,
    canProceed: planned.blockers.length === 0 && !unresolved,
    blockers: [
      ...planned.blockers.map((item) => publicImpact(item, publicIdByEntityId)),
      ...(unresolved ? [unresolvedBlocker(input.relation, unresolved)] : []),
    ],
    changes: planned.changes.map((item) =>
      publicImpact(item, publicIdByEntityId),
    ),
    sideEffects: (planned.sideEffects ?? []).map((item) =>
      publicImpact(item, publicIdByEntityId),
    ),
    generatedAt: now.toISOString(),
  });
};

const unresolvedBlocker = (entity: string, codes: string[]): ImpactItem => ({
  code: "block-unresolved-target",
  effect: "block",
  label: `unknown ${entity}: ${codes.join(", ")}`,
  description: `No live ${entity} matches ${codes.join(", ")}. The code is well-formed, so it was deleted or never existed.`,
  total: codes.length,
  byTargetId: Object.fromEntries(codes.map((code) => [code, 1])),
});

const publicImpact = (
  item: ImpactItem,
  publicIdByEntityId: ReadonlyMap<string, string>,
): PublicImpactItem => toPublicImpact(item, publicIdByEntityId, "drop");
