import { entityRefKey } from "@cubby/schemas/entity";
import type {
  ImpactItem,
  PreviewOperation,
  PreviewOperationInput,
  PublicImpactItem,
} from "@cubby/schemas/entity-integrity";
import {
  previewOperationSchema,
  toPublicImpact,
} from "@cubby/schemas/entity-integrity";
import { parseEntityId, parseEntityRef } from "@cubby/schemas/identifiers";
import { match } from "ts-pattern";

import type { Database } from "~/server/db";
import {
  previewAttachProductComponents,
  previewDetachProductComponents,
} from "~/server/repo/product-components";
import {
  previewAttachProjectResources,
  previewDetachProjectResources,
} from "~/server/repo/project/tools";
import {
  previewAttachPurchaseProducts,
  previewDetachPurchaseProducts,
} from "~/server/repo/purchase-products";
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
  input: PreviewOperationInput,
): Promise<{
  planned: Planned;
  publicIdByEntityId: Map<string, string>;
  unresolved?: string[];
}> => {
  const [parentIds, productIds] = await Promise.all([
    resolveLiveShortcodes(db, [input.parentId], input.entity),
    resolveLiveShortcodes(db, input.productIds, "product"),
  ]);
  const unresolved = [
    ...(parentIds.has(input.parentId) ? [] : [input.parentId]),
    ...input.productIds.filter((code) => !productIds.has(code)),
  ];
  if (unresolved.length > 0) {
    return { planned: EMPTY_PLAN, publicIdByEntityId: new Map(), unresolved };
  }

  const parentId = parentIds.get(input.parentId)!;
  const targets = input.productIds.map((code) =>
    parseEntityId("product", productIds.get(code)!),
  );
  const planned = await match(input)
    .with({ operation: "attach", entity: "product" }, () =>
      previewAttachProductComponents(
        db,
        parseEntityId("product", parentId),
        targets,
      ),
    )
    .with({ operation: "detach", entity: "product" }, () =>
      previewDetachProductComponents(
        db,
        parseEntityId("product", parentId),
        targets,
      ),
    )
    .with({ operation: "attach", entity: "project" }, () =>
      previewAttachProjectResources(
        db,
        parseEntityId("project", parentId),
        targets,
      ),
    )
    .with({ operation: "detach", entity: "project" }, () =>
      previewDetachProjectResources(
        db,
        parseEntityId("project", parentId),
        targets,
      ),
    )
    .with({ operation: "attach", entity: "purchase" }, () =>
      previewAttachPurchaseProducts(
        db,
        parseEntityId("purchase", parentId),
        targets,
      ),
    )
    .with({ operation: "detach", entity: "purchase" }, () =>
      previewDetachPurchaseProducts(
        db,
        parseEntityId("purchase", parentId),
        targets,
      ),
    )
    .exhaustive();

  const codes = await lookupShortcodes(db, [
    parseEntityRef(input.entity, parentId),
    ...targets.map((id) => ({ entity: "product" as const, id })),
  ]);
  const publicIdByEntityId = new Map(
    [
      [input.entity, parentId] as const,
      ...targets.map((id) => ["product", id] as const),
    ].flatMap(([entity, id]) => {
      const code = codes.get(entityRefKey(entity, id));
      return code ? [[id, code] as const] : [];
    }),
  );
  return { planned, publicIdByEntityId };
};

export const previewOperation = async (
  db: Database,
  input: PreviewOperationInput,
  now: Date,
): Promise<PreviewOperation> => {
  const { planned, publicIdByEntityId, unresolved } = await planRelation(
    db,
    input,
  );
  return previewOperationSchema.parse({
    operation: input.operation,
    entity: input.entity,
    targetCount: input.productIds.length,
    canProceed: planned.blockers.length === 0 && !unresolved,
    blockers: [
      ...planned.blockers.map((item) => publicImpact(item, publicIdByEntityId)),
      ...(unresolved ? [unresolvedBlocker(input.entity, unresolved)] : []),
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
