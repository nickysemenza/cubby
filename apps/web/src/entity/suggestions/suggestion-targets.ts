import type { EntityFieldModel } from "@cubby/schemas/entity-fields";
import type { ShortcodeEntity } from "@cubby/schemas/entity-manifest";
import { fieldSuggestionContextKeys } from "@cubby/schemas/field-suggestion";
import type { FinanceReviewContext } from "@cubby/schemas/field-suggestion-policy";
import type { QueryClient } from "@tanstack/react-query";

import { entityMetadata } from "~/entity/metadata";

type ManifestField = EntityFieldModel["fields"][number];

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
  /** Declared saved-record spending review, which reads saved evidence. */
  readonly financeReview: FinanceReviewContext | null;
}

export interface SuggestTargets {
  readonly targets: readonly SuggestTarget[];
  /** Union of every target's `basis`, deduped — what the caller must watch. */
  readonly basisKeys: readonly string[];
}

/** Declared suggestion dependencies plus the raw assignment/source keys the
 * authoritative inheritance resolver needs for this entity. */
export function suggestionContextKeys(
  entity: ShortcodeEntity,
  targets: SuggestTargets,
): readonly string[] {
  return fieldSuggestionContextKeys(entity, targets.basisKeys);
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
  queryClient: QueryClient,
  entity: ShortcodeEntity,
  fieldKeys?: readonly string[],
): SuggestTargets {
  const fields = entityMetadata(queryClient, entity).fields.fields;
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
      financeReview:
        "financeReview" in suggest ? suggest.financeReview.context : null,
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
