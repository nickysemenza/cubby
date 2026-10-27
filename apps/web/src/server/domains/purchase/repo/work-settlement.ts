import { entitySchema } from "@cubby/schemas/entity";
import { entitySummary } from "@cubby/schemas/entity-summary";
import { purchaseFiltersSchema } from "@cubby/schemas/purchase";
import { workExecutor } from "@cubby/schemas/work-queue";
import { and, sql } from "drizzle-orm";

import { compileProblemFilters } from "~/entity/problems/problem-filter-semantics";
import { householdLocalDate } from "~/lib/household-date";
import { related, quotedTable } from "~/server/db/helpers/related";
import { expense, purchase } from "~/server/db/schema";
import { buildPurchaseWhereClause } from "~/server/domains/purchase/repo/purchase";
import {
  awaitingPostingSql,
  purchasePostingStartSql,
} from "~/server/domains/purchase/repo/settlement-grace";
import { purchaseWorkFacts } from "~/server/domains/purchase/repo/work-facts";
import { workPurchaseOwners } from "~/server/domains/purchase/repo/work-owners";
import { gapCondition } from "~/server/generic/data-quality/repo/sql";
import { recordScope } from "~/server/generic/work-queue/repo/work-declarations";
import {
  selectWorkCandidates,
  type WorkSource,
} from "~/server/generic/work-queue/repo/work-source";

const source: WorkSource = {
  id: "reconciliation:purchase-unsettled",
  family: "reconciliation",
  executor: "dynamic",
  entity: "purchase",
  link: { kind: "record" },
  reasons: [
    {
      key: "reconciliation:purchase-unsettled",
      label: "No settlement evidence",
    },
    {
      key: "awaiting_posting:reconciliation:purchase-unsettled",
      label: "Awaiting posting; no settlement evidence",
    },
  ],
  candidates: async (db, scope) => {
    const view = entitySummary.purchase.list.savedViews.find(
      (view) => view.id === "unsettled",
    );
    if (!view) throw new Error("Purchase unsettled view missing");
    const deferred = awaitingPostingSql(
      purchasePostingStartSql(quotedTable(purchase)),
    );
    return {
      query: selectWorkCandidates(db, source, {
        entity: "purchase",
        id: sql`${purchase.shortcode}`,
        name: sql`coalesce("Purchase"."displayLabel", "Purchase"."orderId", 'Purchase')`,
        owners: workPurchaseOwners(sql`"Purchase".id`),
        ...purchaseWorkFacts(),
        executor: sql`CASE WHEN ${deferred} THEN ${workExecutor.enum.external} ELSE ${workExecutor.enum.human} END`,
        reason: sql`CASE WHEN ${deferred} THEN ${source.reasons[1]!.label} ELSE ${source.reasons[0]!.label} END`,
        reasonKeys: sql`ARRAY[CASE WHEN ${deferred} THEN ${source.reasons[1]!.key} ELSE ${source.reasons[0]!.key} END]`,
      })
        .from(purchase)
        .where(
          and(
            buildPurchaseWhereClause(
              purchaseFiltersSchema.parse(
                compileProblemFilters("purchase", view.filters),
              ),
            ),
            sql`NOT (${gapCondition("purchase", "settlement_mismatch")})`,
            recordScope(scope, sql`${purchase.shortcode}`),
          ),
        ),
    };
  },
};
export const purchaseSettlementWorkSource = source;

/** Defer every family before counts. An empty purchase has unknown intent. */
export const plannedPurchaseWorkDeferral = () =>
  sql`work.entity = ${entitySchema.enum.purchase} AND ${related(
    purchase,
    (planned) => sql`${planned.shortcode} = work.id`,
  )
    .where(
      (planned) =>
        sql`${planned.date} > ${householdLocalDate(new Date())}::date OR (${related(expense, (line) => sql`${line.purchaseId} = ${planned.id}`).exists()} AND NOT ${related(
          expense,
          (line) => sql`${line.purchaseId} = ${planned.id}`,
        )
          .where((line) => sql`${line.future} = false`)
          .exists()})`,
    )
    .exists()}`;
