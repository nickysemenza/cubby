import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";

import { referenceFieldReadFields } from "../entity-references";
import { readPathRoot } from "../read-path";

type ManifestField =
  (typeof entityFieldModels)[ShortcodeEntity]["fields"][number];

/** A manifest field whose `control.suggest` opts it into auto-suggestion. */
interface SuggestTarget {
  readonly key: string;
  readonly label: string;
  readonly reference: ManifestField["reference"];
  /** The model fields (of the same entity) whose values feed this target. */
  readonly basis: readonly string[];
  /** `"fill"` proposes a value; `"prune"` (text-array only) proposes
   * removing entries that restate a `basis` field. */
  readonly mode: "fill" | "prune";
}

export interface SuggestTargets {
  readonly targets: readonly SuggestTarget[];
  /** Union of every target's `basis`, deduped — what the caller must watch. */
  readonly basisKeys: readonly string[];
}

const INHERITANCE_CONTEXT_KEYS = {
  expense: ["lineKind", "purchaseId", "productId", "projectId", "trade"],
  task: [
    "parentTaskId",
    "projectId",
    "projectMode",
    "subjectProductId",
    "subjectProductMode",
    "trade",
  ],
} as const satisfies Partial<Record<ShortcodeEntity, readonly string[]>>;

/** Declared suggestion dependencies plus the raw assignment/source keys the
 * authoritative inheritance resolver needs for this entity. */
export function suggestionContextKeys(
  entity: ShortcodeEntity,
  targets: SuggestTargets,
): readonly string[] {
  const inheritedKeys: readonly string[] =
    entity === "expense"
      ? INHERITANCE_CONTEXT_KEYS.expense
      : entity === "task"
        ? INHERITANCE_CONTEXT_KEYS.task
        : [];
  const financeKeys =
    entity === "financialTransaction"
      ? ["purchaseId", "spendingCategoryId", "itemizationExpectation"]
      : entity === "purchase"
        ? ["vendorId", "spendingCategoryId", "itemizationExpectation"]
        : [];
  return [...new Set([...targets.basisKeys, ...inheritedKeys, ...financeKeys])];
}

const EMPTY_TARGETS: SuggestTargets = { targets: [], basisKeys: [] };

/**
 * Every `control.suggest` field of `entity`, optionally restricted to a
 * roster of field keys (e.g. the mounted intent's field list — a form that
 * only renders a subset of the entity's fields has no business asking the decision model to
 * fill in ones it never shows), plus the deduped union of their basis keys —
 * what a caller (the provider, or a single-field surface) needs to watch.
 */
export function suggestTargetsFor(
  entity: ShortcodeEntity,
  fieldKeys?: readonly string[],
): SuggestTargets {
  const fields = entityFieldModels[entity].fields;
  const roster = fieldKeys ? new Set(fieldKeys) : null;
  const targets: SuggestTarget[] = [];
  const basisKeys = new Set<string>();
  for (const field of fields) {
    const suggest = field.control?.suggest;
    if (!suggest) continue;
    if (roster && !roster.has(field.key)) continue;
    targets.push({
      key: field.key,
      label: field.label,
      reference: field.reference,
      basis: suggest.basis,
      mode: suggest.mode,
    });
    for (const basisKey of suggest.basis) basisKeys.add(basisKey);
    // A prune target judges its own current entries, so it is an implicit
    // self-basis (the manifest compiler rejects naming it explicitly) — add
    // it here so every caller that watches `basisKeys` (the provider, a
    // record's basis snapshot) ships the target's current value too.
    if (suggest.mode === "prune") basisKeys.add(field.key);
  }
  if (targets.length === 0) return EMPTY_TARGETS;
  return { targets, basisKeys: [...basisKeys] };
}

/** Visible aliases and canonical field keys share one suggestion admission owner. */
export function visibleSuggestTargets(
  entity: ShortcodeEntity,
  fieldKeys: readonly string[],
) {
  const visible = new Set(fieldKeys);
  const updateFields: readonly string[] = entityFieldModels[entity].update;
  return suggestTargetsFor(
    entity,
    entityFieldModels[entity].fields
      .filter(
        (field) =>
          visible.has(field.key) ||
          (field.reference != null &&
            visible.has(field.key.replace(/Id$/u, ""))) ||
          visible.has(field.display.columnId ?? field.key),
      )
      .map((field) => field.key)
      .filter((key) => updateFields.includes(key)),
  );
}

/** Inputs used by current values, basis labels and inheritance fingerprints. */
export function suggestionReadFields(
  entity: ShortcodeEntity,
  targets: SuggestTargets,
): string[] {
  if (targets.targets.length === 0) return [];
  const keys = new Set([
    ...suggestionContextKeys(entity, targets),
    ...targets.targets.map((target) => target.key),
  ]);
  const fields = ["fieldResolutions"];
  for (const key of keys) {
    const field = entityFieldModels[entity].fields.find(
      (candidate) => candidate.key === key,
    );
    const root = readPathRoot(field?.readKey ?? key);
    if (root) fields.push(root);
    if (field?.reference) fields.push(...referenceFieldReadFields(field));
  }
  return [...new Set(fields)];
}
