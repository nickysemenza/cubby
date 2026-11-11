import {
  actionAvailabilityRuleFor,
  type EntityActionState,
} from "@cubby/schemas/action-availability";
import type { Entity } from "@cubby/schemas/entity";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { z } from "zod";

import { readPathValue } from "~/entity/read-path";

/**
 * The verbs a record of `entity` offers anywhere: the compiled detail hero
 * verbs (`edit`, `delete`, declared hero verbs), then the list verbs
 * (declared, `bulkEdit`, `merge`, `delete`). Capability gating already
 * happened in the manifest compiler, so every id here can apply.
 */
const entityActionIds = (entity: Entity): readonly string[] => {
  const summary = entitySummary[entity];
  return [
    ...new Set<string>([
      ...summary.detail.hero.actions,
      ...summary.list.actions,
    ]),
  ];
};

const present = (value: unknown) =>
  value !== null &&
  value !== undefined &&
  value !== "" &&
  !(Array.isArray(value) && value.length === 0);

const firstKey = (path: string) => path.split(/[.[]/u, 1)[0] ?? path;

/**
 * The action-state port: a record field its entity's read fills with the
 * availability of verbs whose rule needs domain state (a Run's status and
 * purpose policy for Pause or Retry). Each key is a verb id, null when the
 * verb can run and the member-facing reason when it cannot; a verb the
 * field omits keeps its declared rule. The server command still rechecks.
 */
export const ACTION_REASONS_FIELD = "actionReasons";
const actionReasons = z.record(z.string(), z.string().nullable());

const readsActionReasons = (entity: Entity) =>
  entityFieldModels[entity].fields.some(
    ({ key }: { readonly key: string }) => key === ACTION_REASONS_FIELD,
  );

/**
 * The row fields the entity's availability rules read. A narrow
 * (`fields`) list read adds them so its rows evaluate the same as a full one.
 */
export const entityActionReadFields = (entity: Entity): string[] => [
  ...new Set([
    ...entityActionIds(entity).flatMap((id) => {
      const rule = actionAvailabilityRuleFor(id);
      return [rule?.requires?.path, rule?.unlessValue?.path].flatMap((path) =>
        path === undefined ? [] : [firstKey(path)],
      );
    }),
    ...(readsActionReasons(entity) ? [ACTION_REASONS_FIELD] : []),
  ]),
];

/** Every roster verb's state for one public (enveloped) record. */
export const entityActionStates = (
  entity: Entity,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The projection boundary: a public row in, read only through `readPathValue`.
  record: unknown,
): EntityActionState[] => {
  const ported = readsActionReasons(entity)
    ? (actionReasons
        .nullable()
        .optional()
        .parse(readPathValue(record, ACTION_REASONS_FIELD)) ?? {})
    : {};
  return entityActionIds(entity).map((id) => {
    if (Object.hasOwn(ported, id)) {
      const reason = ported[id] ?? null;
      return { id, enabled: reason === null, reason };
    }
    const rule = actionAvailabilityRuleFor(id);
    const reason =
      rule?.requires && !present(readPathValue(record, rule.requires.path))
        ? rule.requires.reason
        : rule?.unlessValue &&
            readPathValue(record, rule.unlessValue.path) ===
              rule.unlessValue.value
          ? rule.unlessValue.reason
          : null;
    return { id, enabled: reason === null, reason };
  });
};

/** A page of records with their `actions`; pure, so a page costs no query. */
export const withEntityActionStates = <Row extends object>(
  entity: Entity,
  rows: readonly Row[],
): Array<Row & { actions: EntityActionState[] }> =>
  rows.map((row) => ({ ...row, actions: entityActionStates(entity, row) }));
