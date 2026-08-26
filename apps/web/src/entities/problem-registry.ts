import { PROBLEM_CLASS, type ProblemKey } from "@cubby/schemas/problems";
import { basicProblemQueries } from "~/entities/problem-queries/basic";
import { derivedProblemQueries } from "~/entities/problem-queries/derived";
import { productCoverageProblemQueries } from "~/entities/problem-queries/product-coverage";
import { trackerProblemQueries } from "~/entities/problem-queries/tracker";
import {
  type ProblemQuery,
  validateProblemQueries,
} from "~/entities/problem-query";
import { entityProblemDeclarations } from "~/entities/view-manifest";

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
