import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { type CompiledEntity, EntityDeclarationError } from "./declarations.ts";

const BASELINE_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "predicate-baseline.json",
);

/**
 * `model.derived` predicates are countable declared exceptions that only
 * shrink: every one must be listed in `predicate-baseline.json` by entity,
 * and an entry whose predicate is gone must leave the file, so a PR can
 * remove entries but never add one.
 */
export const validatePredicateBaseline = (
  entities: readonly CompiledEntity[],
): void => {
  const baseline = z
    .record(z.string(), z.array(z.string()))
    .parse(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
  const declared = new Map(
    entities.map((entity) => [
      entity.key,
      Object.entries(entity.fieldModel.derived)
        .filter(([, entry]) => "predicate" in entry)
        .map(([key]) => key),
    ]),
  );
  for (const [entity, keys] of declared)
    for (const key of keys)
      if (!baseline[entity]?.includes(key))
        throw new EntityDeclarationError(
          `${entity}.model.derived.${key} is a predicate outside predicate-baseline.json; declare a row set, inherited value, value or scope instead (docs/entities.md#filters-and-search).`,
        );
  for (const [entity, keys] of Object.entries(baseline))
    for (const key of keys)
      if (!declared.get(entity)?.includes(key))
        throw new EntityDeclarationError(
          `predicate-baseline.json lists ${entity}.${key}, which is no longer a predicate; remove the entry.`,
        );
};
