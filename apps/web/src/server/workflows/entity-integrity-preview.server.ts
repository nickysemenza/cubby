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
import { bindWorkflow, workflow } from "~/server/workflow-runtime";

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

type PreviewPlan = {
  planned: Planned;
  publicIdByEntityId: Map<string, string>;
  unresolved?: string[];
};

type PreviewInput = { command: GeneratedEntityRelationCommand; now: Date };

export const previewOperation = bindWorkflow(
  workflow<Database, PreviewInput>("entityIntegrity.previewOperation")
    .parallel("ids", 2, {
      parent: async ({ context }, { input }) =>
        resolveLiveShortcodes(
          context,
          [input.command.id],
          input.command.entity,
        ),
      targets: async ({ context }, { input }) =>
        resolveLiveShortcodes(
          context,
          generatedEntityRelationItemIds(input.command),
          generatedEntityRelationTarget(input.command),
        ),
    })
    .call("resolved", async (_, { input: { command }, ids }) => {
      const codes = generatedEntityRelationItemIds(command);
      return {
        targetEntity: generatedEntityRelationTarget(command),
        parentId: ids.parent.get(command.id),
        targets: codes.flatMap((code) => {
          const id = ids.targets.get(code);
          return id ? [id] : [];
        }),
        unresolved: [
          ...(ids.parent.has(command.id) ? [] : [command.id]),
          ...codes.filter((code) => !ids.targets.has(code)),
        ],
      };
    })
    .branch("plan", {
      when: async (_, { resolved }) => resolved.unresolved.length === 0,
      whenTrue: (branch) =>
        branch
          .call(
            "planned",
            async ({ context }, { input: { input, resolved } }) =>
              previewGeneratedRelationMutation(
                context,
                input.command,
                // All requested shortcodes resolved before entering this branch.
                resolved.parentId!,
                resolved.targets,
              ),
          )
          .call(
            "publicIds",
            async ({ context }, { input: { input, resolved } }) => {
              const refs = [
                parseEntityRef(input.command.entity, resolved.parentId!),
                ...resolved.targets.map((id) =>
                  parseEntityRef(resolved.targetEntity, id),
                ),
              ];
              const codes = await lookupShortcodes(context, refs);
              return new Map(
                refs.flatMap(({ entity, id }) => {
                  const code = codes.get(entityRefKey(entity, id));
                  return code ? [[id, code] as const] : [];
                }),
              );
            },
          )
          .output(({ planned, publicIds }): PreviewPlan => ({
            planned,
            publicIdByEntityId: publicIds,
          })),
      whenFalse: (branch) =>
        branch.output(({ input: { resolved } }): PreviewPlan => ({
          planned: EMPTY_PLAN,
          publicIdByEntityId: new Map(),
          unresolved: resolved.unresolved,
        })),
    })
    .output(({ input: { command, now }, plan }): PreviewOperation => {
      const { planned, publicIdByEntityId, unresolved } = plan;
      return previewOperationSchema.parse({
        operation: command.action,
        entity: command.entity,
        relation: command.relation,
        targetCount: command.items.length,
        canProceed: planned.blockers.length === 0 && !unresolved,
        blockers: [
          ...planned.blockers.map((item) =>
            publicImpact(item, publicIdByEntityId),
          ),
          ...(unresolved
            ? [unresolvedBlocker(command.relation, unresolved)]
            : []),
        ],
        changes: planned.changes.map((item) =>
          publicImpact(item, publicIdByEntityId),
        ),
        sideEffects: (planned.sideEffects ?? []).map((item) =>
          publicImpact(item, publicIdByEntityId),
        ),
        generatedAt: now.toISOString(),
      });
    }),
  (db: Database, command: GeneratedEntityRelationCommand, now: Date) => ({
    context: db,
    input: { command, now },
  }),
);

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
