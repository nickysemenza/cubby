import { problemQueryDeclarations } from "@cubby/schemas/entity-definitions/problems/problem-registry";
import {
  AUTO_FIX_PROBLEM_KEYS,
  problemsCountSchema,
  type ProblemsCount,
} from "@cubby/schemas/problems";
import { sql } from "drizzle-orm";
import { sumBy } from "es-toolkit";

import { unwrapDb, withTransactionDatabase } from "~/server/db/helpers";
import { isStatementTimeout } from "~/server/errors/db-errors";
import { executeProblem } from "~/server/generic/problems/service/problem-execution.service";
import { traceAllBounded } from "~/server/observability/tracing";
import type { AuthenticatedOperationContext } from "~/server/operation-runtime/operation.server";

type ProblemCountsContext = Pick<
  AuthenticatedOperationContext,
  "db" | "upcLookupClient"
>;

const REPORT_BUDGET_MS = 8_000;
const STATEMENT_BUDGET_MS = 2_000;

/** Reuse each detector's count intent and report any timed-out categories. */
export async function readProblemCounts({
  db,
  upcLookupClient,
}: ProblemCountsContext): Promise<ProblemsCount> {
  const declarations = problemQueryDeclarations();
  const deadline = Date.now() + REPORT_BUDGET_MS;
  const counted = declarations.filter(
    (definition) => definition.executionLane !== "upc",
  );
  const tasks = Object.fromEntries(
    counted.map(
      ({ key }) =>
        [
          key,
          async () => {
            if (Date.now() >= deadline) return undefined;
            try {
              return await withTransactionDatabase(
                db,
                async (tx) => {
                  const remaining = deadline - Date.now();
                  if (remaining <= 0) return undefined;
                  await unwrapDb(tx).execute(
                    sql`SELECT set_config('statement_timeout', ${String(Math.min(remaining, STATEMENT_BUDGET_MS))}, true)`,
                  );
                  return (
                    await executeProblem(tx, key, {
                      mode: "count",
                      diagnostic: { upcLookupClient },
                    })
                  ).count;
                },
                { accessMode: "read only" },
              );
            } catch (error) {
              if (!isStatementTimeout(error)) throw error;
              return undefined;
            }
          },
        ] as const,
    ),
  );
  const results = await traceAllBounded(tasks, 4);
  const incompleteTypes = counted
    .filter(({ key }) => results[key] === undefined)
    .map(({ key }) => key);
  const byType = problemsCountSchema.shape.byType.parse(
    Object.fromEntries(declarations.map(({ key }) => [key, results[key] ?? 0])),
  );
  const totalFor = (problemClass: "defect" | "coverage") =>
    declarations.reduce(
      (total, definition) =>
        definition.problemClass === problemClass
          ? total + byType[definition.key]
          : total,
      0,
    );
  const autoFixTotal = sumBy(AUTO_FIX_PROBLEM_KEYS, (key) => byType[key]);
  return {
    total: totalFor("defect") - autoFixTotal,
    autoFixTotal,
    coverageTotal: totalFor("coverage"),
    byType,
    ...(incompleteTypes.length > 0 ? { incompleteTypes } : {}),
  };
}
