import type { Entity } from "@cubby/schemas/entity";
import { fieldSuggestionContextKeys } from "@cubby/schemas/field-suggestion";
import type { QueryClient } from "@tanstack/react-query";

import { entityMetadata } from "~/entity/metadata";

export const DEFAULT_LIST_COLUMN_VISIBILITY = {
  machineryGap: false,
  machineryActor: false,
  machineryAttempts: false,
  machineryCost: false,
  machineryEta: false,
  createdAt: false,
  updatedAt: false,
} as const;

/** Preloads and mounted tables preserve the same member-owned visibility. */
export const listReadVisibility = (
  visibility: Readonly<Record<string, boolean>>,
) => ({
  ...DEFAULT_LIST_COLUMN_VISIBILITY,
  ...visibility,
});

/** Search alone keeps relevance paging; other filters need exact membership counts. */
export const listReadNeedsCount = (
  primarySearchKey: string | undefined,
  filterIds: readonly string[],
): boolean => filterIds.some((id) => id !== primarySearchKey);

export type ListReadProjection = {
  (
    queryClient: QueryClient,
    entity: Entity,
    visibility?: Readonly<Record<string, boolean>>,
  ): string[];
  /** A client tree needs the matching flat roster, including during preload. */
  nesting?: "flat";
};

const readRoot = (path: string | null | undefined) =>
  path?.split(".")[0]?.split("[")[0];

/**
 * What the shared state and progress cells and the title cell read whether
 * or not their own columns show: a state's reason, wait and stalled flag,
 * the progress note, the kind tag and the declared second line.
 */
function declaredPresentationReads(
  metadata: ReturnType<typeof entityMetadata>,
): string[] {
  const state: {
    field: string;
    reason?: string;
    wait?: string;
    stalled?: string;
  } | null = metadata.summary.state;
  const progress: { field: string; note?: string } | null =
    metadata.summary.progress;
  const secondLine = metadata.summary.list.titleSubtitle
    ? (metadata.summary.list.shelf?.subtitle ?? [])
    : [];
  return [
    state?.field,
    state?.reason,
    state?.wait,
    state?.stalled,
    progress?.field,
    progress?.note,
    metadata.summary.kind?.field,
    ...secondLine,
  ].flatMap((key) => {
    if (!key) return [];
    const field = metadata.fields.fields.find((entry) => entry.key === key);
    const label = readRoot(field?.display.labelPath);
    return [
      readRoot(field?.display.readPath) ?? field?.readKey ?? key,
      ...(label ? [label] : []),
    ];
  });
}

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
    "pendingSuggestionCount",
    "machinery",
  ]);
  const readable = new Set<string>([
    ...metadata.fields.output,
    ...metadata.envelopeFields,
  ]);
  // Standard columns also inject Quality without a declared entity field.
  if (visibility.dataQuality !== false && readable.has("dataQuality"))
    wanted.add("dataQuality");
  // The record mark leads the locked image column, so it is read with every
  // row although the emoji field itself is not a list column.
  for (const mark of [
    metadata.summary.recordEmojiField,
    metadata.summary.recordGlyph?.field,
  ])
    if (mark && readable.has(mark)) wanted.add(mark);
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
  for (const read of declaredPresentationReads(metadata))
    if (readable.has(read)) wanted.add(read);
  // Audit columns are requested only when the shared presentation exposes them.
  if (visibility.createdAt !== false) wanted.add("createdAt");
  if (visibility.updatedAt !== false) wanted.add("updatedAt");
  return [...wanted].sort();
};

/** Specialist row consumers share the same projection in loaders and mounted lists. */
export function specialistListReadProjection({
  always = [],
  nesting,
  whenShown = {},
  whenRevealed = {},
}: {
  always?: readonly string[];
  nesting?: "flat";
  /** Composed columns shown by default; declared columns use display.readFields. */
  whenShown?: Readonly<Record<string, readonly string[]>>;
  whenRevealed?: Readonly<Record<string, readonly string[]>>;
}): ListReadProjection {
  const projection: ListReadProjection = (
    queryClient,
    entity,
    visibility = DEFAULT_LIST_COLUMN_VISIBILITY,
  ) => {
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
  projection.nesting = nesting;
  return projection;
}
