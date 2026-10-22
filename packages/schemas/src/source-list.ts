import type { FilterKind } from "./entity-definitions/definition";
import type { GeneratedGroupChoice } from "./generated/entity-list-fields.gen";
import { nonEmptyTuple } from "./identifier-fields";

/**
 * A declared filter of a list whose rows are projected from several sources
 * rather than read from one entity's table. It is the serializable part of the
 * web `FilterSpecCore`, so the web table consumes it unchanged.
 */
interface SourceListFilter {
  columnId: string;
  field?: string;
  urlKey?: string;
  kind: FilterKind;
  /** Offers `@me`, the signed-in member (ADR 0018). */
  currentMember?: boolean;
  /** The presence field `No value` / `Any value` write (`has` | `none`). */
  nullable?: { field: string; label: string };
}

type GroupOptions = readonly {
  readonly value: string;
  readonly label: string;
}[];

/** A Group by choice the list's read sections by, in the entity list's shape. */
type SupportedChoice<K extends string> = GeneratedGroupChoice & {
  readonly key: K;
  readonly reason: null;
};
type UnsupportedChoice<K extends string> = GeneratedGroupChoice & {
  readonly key: K;
  readonly reason: string;
};

/**
 * A flat section over a projected value. `filter` names the declared filter
 * a section's key selects ("Filter to this"); `noValue` means that filter
 * also selects the no-value section. `options` are the value's known labels.
 */
export const sourceGroupChoice = <const K extends string>(choice: {
  key: K;
  label: string;
  noValueLabel?: string;
  filter: { columnId: string; noValue: boolean } | null;
  options?: GroupOptions;
}): SupportedChoice<K> => ({
  key: choice.key,
  label: choice.label,
  noValueLabel: choice.noValueLabel ?? "None",
  reason: null,
  value: { kind: "derived", options: choice.options ?? null },
  filter: choice.filter && { ...choice.filter, subtree: null },
  levels: 0,
  levelReason: `${choice.label} is a flat section, not a hierarchy.`,
  multiple: false,
  dateKind: null,
  buckets: [],
});

/** A field the list cannot section by, with the reason a menu states. */
export const unsupportedGroupChoice = <const K extends string>(choice: {
  key: K;
  label: string;
  reason: string;
}): UnsupportedChoice<K> => ({
  key: choice.key,
  label: choice.label,
  noValueLabel: "None",
  reason: choice.reason,
  value: null,
  filter: null,
  levels: 0,
  levelReason: choice.reason,
  multiple: false,
  dateKind: null,
  buckets: [],
});

export interface SourceListDeclaration<
  C extends GeneratedGroupChoice = GeneratedGroupChoice,
> {
  filters: readonly SourceListFilter[];
  grouping: readonly C[];
}

/** Checks that each choice's filter is a declared one, at module load. */
export function defineSourceList<
  const C extends SupportedChoice<string> | UnsupportedChoice<string>,
>(list: SourceListDeclaration<C>): SourceListDeclaration<C> {
  for (const choice of list.grouping) {
    const columnId = choice.filter?.columnId;
    if (columnId && !list.filters.some((spec) => spec.columnId === columnId))
      throw new Error(
        `Group by ${choice.key} filters by undeclared column ${columnId}`,
      );
  }
  return list;
}

/** The choices a read sections by: those without a reason. */
export const supportedGroupChoices = <C extends GeneratedGroupChoice>(
  list: SourceListDeclaration<C>,
) =>
  list.grouping.filter(
    (choice): choice is Extract<C, { reason: null }> => choice.reason === null,
  );

/** The keys a read accepts as `group`. */
export const supportedGroupKeys = <C extends GeneratedGroupChoice>(
  list: SourceListDeclaration<C>,
) =>
  nonEmptyTuple<Extract<C, { reason: null }>["key"]>(
    supportedGroupChoices(list).map((choice) => choice.key),
  );
