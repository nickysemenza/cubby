import type { Entity } from "@cubby/schemas/entity";
import { fieldSuggestionContextKeys } from "@cubby/schemas/field-suggestion";
import type { QueryClient } from "@tanstack/react-query";

import { entityMetadata } from "~/entity/metadata";

export type ListReadProjection = (
  queryClient: QueryClient,
  entity: Entity,
  visibility?: Readonly<Record<string, boolean>>,
) => string[] | undefined;

/** Shared by the eager loader and mounted roster; visibility never changes membership. */
export const declaredListReadProjection: ListReadProjection = (
  queryClient,
  entity,
  visibility = {},
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
    "displayImages",
  ]);
  const readable = new Set<string>([
    ...metadata.fields.output,
    ...metadata.envelopeFields,
  ]);
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
    // Standard thumbnails use displayImages or their renderer's explicit
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
  // The route-primary roster explicitly shows these standard columns; an
  // embedded caller can hide them without changing server filter semantics.
  if (visibility.createdAt !== false) wanted.add("createdAt");
  if (visibility.updatedAt !== false) wanted.add("updatedAt");
  return [...wanted].sort();
};
