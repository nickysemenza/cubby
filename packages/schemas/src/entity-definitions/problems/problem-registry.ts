import { PROBLEM_CLASS, type ProblemKey } from "@cubby/schemas/problems";

import { entityProblemDeclarations } from "@cubby/schemas/entity-definitions/problems/view-problems";
import {
  type ProblemQuery,
  validateProblemQueries,
} from "@cubby/schemas/entity-definitions/problems/problem-query";
import { basicProblemQueries } from "@cubby/schemas/entity-definitions/problems/queries/basic";
import { derivedProblemQueries } from "@cubby/schemas/entity-definitions/problems/queries/derived";
import { productCoverageProblemQueries } from "@cubby/schemas/entity-definitions/problems/queries/product-coverage";
import { trackerProblemQueries } from "@cubby/schemas/entity-definitions/problems/queries/tracker";

/**
 * The one canonical roster for Problems presentation and continuation.
 *
 * Focused modules own declarations for their domain; this file only composes
 * them and checks the registry boundary. In particular, it contains no SQL,
 * Drizzle expressions, or detector callbacks.
 */
/** Full schema roster; it makes a new ProblemKey a registry compile/test gate. */
const isProblemKey = (key: string): key is ProblemKey =>
  Object.hasOwn(PROBLEM_CLASS, key);

export const expectedProblemKeys =
  Object.keys(PROBLEM_CLASS).filter(isProblemKey);

const definitions: readonly ProblemQuery[] = [
  ...entityProblemDeclarations(),
  ...basicProblemQueries,
  ...productCoverageProblemQueries,
  ...trackerProblemQueries,
  ...derivedProblemQueries,
];
validateProblemQueries(definitions, expectedProblemKeys);
const definitionByKey = new Map(
  definitions.map((definition) => [definition.key, definition]),
);

export const problemQueryDeclarations = (): readonly ProblemQuery[] =>
  definitions;

export const problemQuery = (key: ProblemKey): ProblemQuery | undefined =>
  definitionByKey.get(key);
