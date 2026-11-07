import type { Entity } from "@cubby/schemas/entity";
import { fieldSuggestionContextKeys } from "@cubby/schemas/field-suggestion";
import type { QueryClient } from "@tanstack/react-query";

import { entityMetadata } from "~/entity/metadata";

export const DEFAULT_LIST_COLUMN_VISIBILITY = {
  createdAt: false,
  updatedAt: false,
} as const;

/** Preloads and mounted tables expose explicitly sorted audit columns alike. */
export const listReadVisibility = (
  visibility: Readonly<Record<string, boolean>>,
  sortedFields: readonly string[],
  defaultSort: string,
) => ({
  ...DEFAULT_LIST_COLUMN_VISIBILITY,
  ...visibility,
  ...Object.fromEntries(
    sortedFields
      .filter(
        (key) =>
          (key === "createdAt" || key === "updatedAt") &&
          !(sortedFields.length === 1 && key === defaultSort),
      )
      .map((key) => [key, true]),
  ),
});

/** Search alone keeps relevance paging; other filters need exact membership counts. */
export const listReadNeedsCount = (
  primarySearchKey: string | undefined,
  filterIds: readonly string[],
): boolean => filterIds.some((id) => id !== primarySearchKey);

export type ListReadProjection = (
  queryClient: QueryClient,
  entity: Entity,
  visibility?: Readonly<Record<string, boolean>>,
) => string[];

/** Shared by the eager loader and mounted roster; visibility never changes membership. */
export const declaredListReadProjection: ListReadProjection = (
  queryClient,
  entity,
  visibility = DEFAULT_LIST_COLUMN_VISIBILITY,
) => {
  const metadata = entityMetadata(queryClient, entity);
  const rootOf = (path: string | null | undefined) =>
    path?.split(".")[0]?.split("[")[0];
  const projectionFor = (field: (typeof metadata.fields.fields)[number]) => {
    const explanation = field.explanation;
    return explanation &&
      "projections" in explanation &&
      "list" in explanation.projections
      ? explanation.projections.list
      : undefined;
  };
  // Every roster injects a locked image column, including entities that only
  // borrow photos and declare no image field of their own.
  const wanted = new Set<string>([
    "id",
    metadata.summary.titleField,
    "displayCover",
  ]);
  const readable = new Set<string>([
    ...metadata.fields.output,
    ...metadata.envelopeFields,
  ]);
  // Standard columns also inject Quality without a declared entity field.
  if (visibility.dataQuality !== false && readable.has("dataQuality"))
    wanted.add("dataQuality");
  for (const field of metadata.fields.fields) {
    if (!field.display.list) continue;
    const column = field.display.columnId ?? field.key;
    if (
      visibility[column] === false ||
      (visibility[column] === undefined && field.display.listHidden)
    )
      continue;
    if ("readFields" in field.display)
      for (const dependency of field.display.readFields ?? [])
        wanted.add(dependency);
    const suggestion = field.control?.suggest;
    if (suggestion)
      for (const key of fieldSuggestionContextKeys(entity, [
        ...suggestion.basis,
        field.key,
      ])) {
        const dependency = metadata.fields.fields.find(
          (entry) => entry.key === key,
        );
        const read =
          dependency?.readKey === null
            ? rootOf(dependency.display.readPath)
            : (dependency?.readKey ?? key);
        // Intent-only inputs without a public projection are unavailable on
        // complete roster rows too; they are not extra list fields to request.
        if (read && readable.has(read)) wanted.add(read);
        if (dependency?.reference) {
          const base = dependency.key.replace(/Ids?$/u, "");
          for (const label of [
            rootOf(dependency.display.labelPath),
            `${base}Name`,
            base,
          ])
            if (label && readable.has(label)) wanted.add(label);
        }
      }
    // Standard thumbnails use displayCover or their renderer's explicit
    // dependencies; the synthetic column id is not a canonical read key.
    if (field.display.standard === "image") continue;
    const read =
      rootOf(projectionFor(field)) ??
      rootOf(field.display.readPath) ??
      field.readKey;
    if (read) wanted.add(read);
    const label = rootOf(field.display.labelPath);
    if (label) wanted.add(label);
  }
  // Audit columns are requested only when the shared presentation exposes them.
  if (visibility.createdAt !== false) wanted.add("createdAt");
  if (visibility.updatedAt !== false) wanted.add("updatedAt");
  return [...wanted].sort();
};

/** Specialist row consumers share the same projection in loaders and mounted lists. */
export function specialistListReadProjection({
  always = [],
  whenShown = {},
  whenRevealed = {},
}: {
  always?: readonly string[];
  /** Composed columns shown by default; declared columns use display.readFields. */
  whenShown?: Readonly<Record<string, readonly string[]>>;
  whenRevealed?: Readonly<Record<string, readonly string[]>>;
}): ListReadProjection {
  return (queryClient, entity, visibility = DEFAULT_LIST_COLUMN_VISIBILITY) => {
    const fields = declaredListReadProjection(queryClient, entity, visibility);
    return [
      ...new Set([
        ...fields,
        ...always,
        ...Object.entries(whenShown).flatMap(([column, keys]) =>
          visibility[column] === false ? [] : keys,
        ),
        ...Object.entries(whenRevealed).flatMap(([column, keys]) =>
          visibility[column] === true ? keys : [],
        ),
      ]),
    ].sort();
  };
}
