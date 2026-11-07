import { classificationFieldDependencies } from "@cubby/schemas/classification-field-policy";
import type { Entity } from "@cubby/schemas/entity";
import {
  entityFieldAssignmentKeys,
  entityFieldEnvelopeDependencies,
  entityFieldEnvelopeKeys,
  entityFieldModels,
} from "@cubby/schemas/entity-fields";

import type { ListProjection } from "~/entity/model/list-read-fields";
import { storedDerived } from "~/server/db/derived-declarations";

/** One request's field dependencies, independent of database execution. */
export type ReadDemand = Readonly<{
  projection: ListProjection;
  envelope: readonly string[];
  facts: Readonly<{
    stored: readonly string[];
    ownership: readonly string[];
    assignments: readonly string[];
  }> | null;
}>;

/** Projector and classification dependencies share the manifest's field owner. */
export function compileReadDemand(
  entity: Entity,
  requested?: ListProjection,
  available: ListProjection = [],
): ReadDemand {
  const governed: readonly string[] =
    Object.entries(entityFieldEnvelopeKeys).find(
      ([key]) => key === entity,
    )?.[1] ?? [];
  const dependencies: Readonly<Partial<Record<string, readonly string[]>>> =
    Object.entries(entityFieldEnvelopeDependencies).find(
      ([key]) => key === entity,
    )?.[1] ?? {};
  const model = entityFieldModels[entity];
  const projection = new Set(requested ?? governed);
  const supported = new Set(available);
  const keys = new Set<string>(
    governed.filter((key) => {
      const field = model.fields.find((field) => field.key === key);
      return (
        projection.has(key) ||
        (field?.readKey != null && projection.has(field.readKey))
      );
    }),
  );
  for (const key of keys) {
    for (const dependency of [
      ...(dependencies[key] ?? []),
      ...classificationFieldDependencies(entity, key),
    ]) {
      if (governed.includes(dependency)) keys.add(dependency);
      if (supported.has(dependency)) projection.add(dependency);
    }
  }
  if (!keys.size)
    return { projection: [...projection], envelope: [], facts: null };
  if (supported.has("fieldResolutions")) projection.add("fieldResolutions");
  const assignments = new Set<string>();
  const stored = new Set<string>();
  const ownership = new Set<string>();
  const assignmentKeys: readonly string[] =
    Object.entries(entityFieldAssignmentKeys).find(
      ([key]) => key === entity,
    )?.[1] ?? [];
  for (const key of keys) {
    const field = model.fields.find((field) => field.key === key);
    if (!field)
      throw new Error(`Missing declared envelope field: ${entity}.${key}`);
    const readKey = field.readKey ?? key;
    if (supported.has(readKey)) projection.add(readKey);
    if (assignmentKeys.includes(key)) assignments.add(key);
    for (const dependency of [
      ...Object.keys(field.resolution?.none ?? {}),
      ...classificationFieldDependencies(entity, key),
    ])
      assignments.add(dependency);
    for (const source of [key, field.readKey, field.storedKey])
      if (source && storedDerived(entity, source)) stored.add(source);
    if (
      field.control?.suggest?.mode === "fill" &&
      !field.control.suggest.reviewRequired
    )
      ownership.add(key);
  }
  return {
    projection: [...projection],
    envelope: [...keys],
    facts: {
      stored: [...stored],
      ownership: [...ownership],
      assignments: [...assignments],
    },
  };
}
