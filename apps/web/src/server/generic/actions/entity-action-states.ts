import {
  actionAvailabilityRuleFor,
  type EntityActionState,
} from "@cubby/schemas/action-availability";
import type { Entity } from "@cubby/schemas/entity";
import { entitySummary } from "@cubby/schemas/entity-summary";

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
 * The row fields the entity's availability rules read. A narrow
 * (`fields`) list read adds them so its rows evaluate the same as a full one.
 */
export const entityActionReadFields = (entity: Entity): string[] => [
  ...new Set(
    entityActionIds(entity).flatMap((id) => {
      const rule = actionAvailabilityRuleFor(id);
      return [rule?.requires?.path, rule?.unlessValue?.path].flatMap((path) =>
        path === undefined ? [] : [firstKey(path)],
      );
    }),
  ),
];

/** Every roster verb's state for one public (enveloped) record. */
export const entityActionStates = (
  entity: Entity,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- The projection boundary: a public row in, read only through `readPathValue`.
  record: unknown,
): EntityActionState[] =>
  entityActionIds(entity).map((id) => {
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

/** A page of records with their `actions`; pure, so a page costs no query. */
export const withEntityActionStates = <Row extends object>(
  entity: Entity,
  rows: readonly Row[],
): Array<Row & { actions: EntityActionState[] }> =>
  rows.map((row) => ({ ...row, actions: entityActionStates(entity, row) }));
