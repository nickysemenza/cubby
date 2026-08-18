import { PROBLEM_CLASS, type ProblemKey } from "@cubby/schemas/problems";
import { basicProblemQueries } from "~/entities/problem-queries/basic";
import { derivedProblemQueries } from "~/entities/problem-queries/derived";
import { productCoverageProblemQueries } from "~/entities/problem-queries/product-coverage";
import { trackerProblemQueries } from "~/entities/problem-queries/tracker";
import {
  findProblemQuery,
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
export function problemQueryDeclarations(): readonly ProblemQuery[] {
  const definitions = [
    ...entityProblemDeclarations(),
    ...basicProblemQueries,
    ...productCoverageProblemQueries,
    ...trackerProblemQueries,
    ...derivedProblemQueries,
  ];
  validateProblemQueries(definitions, expectedProblemKeys);
  return definitions;
}

/** Full schema roster; it makes a new ProblemKey a registry compile/test gate. */
export const expectedProblemKeys = Object.keys(PROBLEM_CLASS) as ProblemKey[];

export const problemQuery = (key: ProblemKey): ProblemQuery | undefined =>
  findProblemQuery(problemQueryDeclarations(), key);
