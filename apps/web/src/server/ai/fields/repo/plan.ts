/**
 * Which columns the `fields` scope reads and writes, from the manifest's
 * `control.suggest` declarations (ADR 0029 section 2, ADR 0028 item 1).
 *
 * A field takes part when it is a `fill` target with a physical column on its
 * entity's table. Only `apply: "auto"` columns are written; `review` and
 * `offer` columns are read, so the scope can show their answers. The money
 * lane's entities (Purchase, Expense, FinancialTransaction) and every declared
 * spending review stay with the money lane: their columns are written by the
 * booking, import and spending-review writers, which only the money lane may
 * move. A prune target is a removal proposal and never applies. A field with an inheritance mode column (Task project) stays
 * authored: the assignment channel has no `inherit` kind to record a
 * person's choice to inherit. A NOT NULL column without a default (Location
 * type, Purchase vendor, Expense cost type) stays authored: its creator
 * always supplies it, and only the kernel may write a column it owns. A
 * reference column is repointed only through the kernel during merge/removal.
 */
import type { AuditFieldChange } from "@cubby/schemas/audit";
import { entityFieldModels } from "@cubby/schemas/entity-fields";
import {
  shortcodeEntities,
  type ShortcodeEntity,
} from "@cubby/schemas/entity-manifest";
import {
  financeReviewContext,
  suggestApplyPolicy,
  type SuggestApplyPolicy,
} from "@cubby/schemas/field-suggestion-policy";
import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";

import { SHORTCODE_TABLE } from "~/server/generated/shortcode-tables.gen";

/** One record's row by column property name. */
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type -- rows of every fields table; each table's InferSelectModel is the contract.
export type FieldsRow = Record<string, unknown>;

/** An audited write's column diff. */
export type FieldsChanges = Readonly<Record<string, AuditFieldChange>>;

export type FieldPlan = {
  readonly key: string;
  readonly apply: SuggestApplyPolicy;
  /** Other records inherit it: Cubby fills it once and never revises it. */
  readonly fillOnly: boolean;
  /** The stored placeholder that records no decision, when the column declares one. */
  readonly undecided: string | null;
  /** The entity a reference field points at, or null. */
  readonly reference: ShortcodeEntity | null;
  /** Basis keys stored as columns of the record's own table. */
  readonly basis: readonly string[];
  /** Reference-valued basis columns: records sharing one are its precedents. */
  readonly parents: readonly string[];
};

export type EntityFieldsPlan = {
  readonly entity: ShortcodeEntity;
  readonly table: PgTable & { id: PgTable["_"]["columns"][string] };
  readonly tableName: string;
  readonly fields: readonly FieldPlan[];
  /** Columns the scope reads: every field's basis and the fields themselves. */
  readonly reads: readonly string[];
  /** The `apply: "auto"` columns the scope writes. */
  readonly writes: readonly string[];
  /** The column a precedent is named by, when the table has one. */
  readonly label: string | null;
  readonly hasDeletedAt: boolean;
  readonly hasUpdatedAt: boolean;
};

const shortcodeEntitySet = new Set<string>(shortcodeEntities);
const isShortcodeEntity = (value: unknown): value is ShortcodeEntity =>
  typeof value === "string" && shortcodeEntitySet.has(value);

const MONEY_LANE_ENTITIES = new Set<string>([
  "purchase",
  "expense",
  "financialTransaction",
]);

function planFor(entity: ShortcodeEntity): EntityFieldsPlan | null {
  if (MONEY_LANE_ENTITIES.has(entity)) return null;
  const table = SHORTCODE_TABLE[entity];
  const columns = getTableColumns(table);
  const has = (key: string) => Object.hasOwn(columns, key);
  const models = entityFieldModels[entity].fields;
  const reference = (key: string): ShortcodeEntity | null => {
    const model = models.find((field) => field.key === key);
    const target = model && "reference" in model ? model.reference : undefined;
    const name =
      target && typeof target === "object" && "entity" in target
        ? target.entity
        : undefined;
    return isShortcodeEntity(name) ? name : null;
  };
  const fields: FieldPlan[] = models.flatMap((field) => {
    const suggest = field.control?.suggest;
    if (!suggest || suggest.mode !== "fill" || !has(field.key)) return [];
    const column = Object.entries(columns).find(
      ([key]) => key === field.key,
    )?.[1];
    if (column?.notNull && !column.hasDefault) return [];
    if (financeReviewContext(entity, field.key)) return [];
    const resolution: object | null | undefined =
      "resolution" in field ? field.resolution : null;
    if (resolution && "inheritMode" in resolution && resolution.inheritMode)
      return [];
    const basis = suggest.basis.filter(has);
    const apply = suggestApplyPolicy(entity, field.key);
    return [
      {
        key: field.key,
        apply,
        fillOnly: "fillOnly" in suggest && suggest.fillOnly === true,
        undecided:
          "undecided" in suggest && typeof suggest.undecided === "string"
            ? suggest.undecided
            : null,
        reference: reference(field.key),
        basis,
        parents: basis.filter((key) => reference(key) !== null),
      },
    ];
  });
  if (!fields.length) return null;
  return {
    entity,
    table,
    tableName: getTableName(table),
    fields,
    reads: [...new Set(fields.flatMap((field) => [...field.basis, field.key]))],
    writes: fields
      .filter((field) => field.apply === "auto")
      .map((field) => field.key),
    label: has("name") ? "name" : has("displayLabel") ? "displayLabel" : null,
    hasDeletedAt: has("deletedAt"),
    hasUpdatedAt: has("updatedAt"),
  };
}

let plans: ReadonlyMap<ShortcodeEntity, EntityFieldsPlan> | null = null;

/**
 * Every entity whose records have a `fields` scope, by entity. Built on first
 * use: entity writers import this module while the table modules initialize.
 */
export function fieldsPlans(): ReadonlyMap<ShortcodeEntity, EntityFieldsPlan> {
  plans ??= new Map(
    shortcodeEntities.flatMap((entity) => {
      const plan = planFor(entity);
      return plan ? [[entity, plan] as const] : [];
    }),
  );
  return plans;
}

/** One entity's plan, or undefined when its records have no `fields` scope. */
export const fieldsPlanOf = (entity: string): EntityFieldsPlan | undefined =>
  isShortcodeEntity(entity) ? fieldsPlans().get(entity) : undefined;

/** The plan of one field, or null when the `fields` scope does not cover it. */
export function fieldPlan(
  entity: string,
  field: string,
): { entity: EntityFieldsPlan; field: FieldPlan } | null {
  const plan = fieldsPlanOf(entity);
  const found = plan?.fields.find((candidate) => candidate.key === field);
  return plan && found ? { entity: plan, field: found } : null;
}
