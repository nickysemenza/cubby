import {
  workExplanationSchema,
  type WorkExplanation,
  type WorkQueueRow,
} from "@cubby/schemas/work-queue";
import { sql, type SQL } from "drizzle-orm";

type RoutingRule = Pick<WorkExplanation, "executor"> &
  Partial<Pick<WorkQueueRow, "source" | "kind">>;
/** One roster drives action explanations and view population before paging. */
const routing: RoutingRule[] = [
  { kind: "awaiting_posting", executor: "automatic" },
  { source: "execution", executor: "automatic" },
  { kind: "research", executor: "agent_session" },
  { kind: "review", executor: "human" },
  { source: "reconciliation", kind: "repair", executor: "human" },
];

export const workExecutor = (row: Pick<WorkQueueRow, "source" | "kind">) =>
  routing.find(
    (rule) =>
      (!rule.source || rule.source === row.source) &&
      (!rule.kind || rule.kind === row.kind),
  )?.executor ?? workExplanationSchema.shape.executor.enum.unknown;

export const workExecutorSql = (source: SQL, kind: SQL) =>
  sql`CASE ${sql.join(
    routing.map((rule) => {
      const predicates = [
        ...(rule.source ? [sql`${source} = ${rule.source}`] : []),
        ...(rule.kind ? [sql`${kind} = ${rule.kind}`] : []),
      ];
      return sql`WHEN ${sql.join(predicates, sql` AND `)} THEN ${rule.executor}::text`;
    }),
    sql` `,
  )} ELSE ${workExplanationSchema.shape.executor.enum.unknown}::text END`;
