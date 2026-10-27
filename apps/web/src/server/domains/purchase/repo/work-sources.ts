import { purchaseFiltersSchema } from "@cubby/schemas/purchase";
import { workExecutor } from "@cubby/schemas/work-queue";
import { and, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { outer, quotedTable } from "~/server/db/helpers/related";
import { purchase as table } from "~/server/db/schema";
import { buildPurchaseWhereClause } from "~/server/domains/purchase/repo/purchase";
import {
  awaitingPostingSql,
  purchasePostingStartSql,
} from "~/server/domains/purchase/repo/settlement-grace";
import { purchaseWorkFacts } from "~/server/domains/purchase/repo/work-facts";
import {
  workPurchaseOwners,
  workPurchaseSourceOwners,
} from "~/server/domains/purchase/repo/work-owners";
import {
  entityProblemSources,
  gapDeclaration,
  gapFilters,
  gapColumns,
  recordScope,
} from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

const gaps = gapDeclaration("purchase");
const gapSource: WorkSource = {
  ...gaps,
  candidates: async (db, scope) => {
    const filters = gapFilters(scope, "purchase");
    if (!filters) return null;
    return {
      query: selectWorkCandidates(db, gaps, {
        entity: "purchase",
        id: sql`${table.shortcode}`,
        name: sql`coalesce("Purchase"."displayLabel", "Purchase"."orderId", 'Purchase')`,
        owners: workPurchaseSourceOwners(outer(table.id)),
        shared: false,
        ...gapColumns(scope, "purchase"),
        ...purchaseWorkFacts(),
      })
        .from(table)
        .where(
          and(
            buildPurchaseWhereClause(purchaseFiltersSchema.parse(filters)),
            recordScope(scope, sql`${table.shortcode}`),
          ),
        ),
    };
  },
};
export const purchaseWorkSources = (): WorkSource[] =>
  [
    gapSource,
    ...entityProblemSources("purchase", async (db, source, scope, assembly) => {
      const filters = compileProblemFilters("purchase", assembly);
      const deferred =
        source.id === "purchaseFinancialSettlementMismatches"
          ? awaitingPostingSql(purchasePostingStartSql(quotedTable(table)))
          : null;
      return {
        query: selectWorkCandidates(db, source, {
          entity: "purchase",
          id: sql`${table.shortcode}`,
          name: sql`coalesce("Purchase"."displayLabel", "Purchase"."orderId", 'Purchase')`,
          owners: workPurchaseOwners(outer(table.id)),
          shared: false,
          executor: deferred
            ? sql`CASE WHEN ${deferred} THEN ${workExecutor.enum.external} ELSE ${workExecutor.enum.human} END`
            : "human",
          reason: deferred
            ? sql`CASE WHEN ${deferred} THEN 'Awaiting posting; recorded settlement amounts differ.' ELSE ${source.reasons[0]!.label} END`
            : source.reasons[0]!.label,
          reasonKeys: deferred
            ? sql`ARRAY[CASE WHEN ${deferred} THEN ${"awaiting_posting:" + source.id} ELSE ${source.id} END]`
            : [source.id],
          ...purchaseWorkFacts(),
        })
          .from(table)
          .where(
            and(
              buildPurchaseWhereClause(purchaseFiltersSchema.parse(filters)),
              recordScope(scope, sql`${table.shortcode}`),
            ),
          ),
      };
    }),
  ].map((source) =>
    source.id === "purchaseFinancialSettlementMismatches"
      ? {
          ...source,
          executor: "dynamic",
          reasons: [
            ...source.reasons,
            {
              key: "awaiting_posting:" + source.id,
              label: "Awaiting posting; recorded settlement amounts differ.",
            },
          ],
        }
      : source,
  );
