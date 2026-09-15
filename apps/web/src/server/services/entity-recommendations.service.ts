import type { EntityRef } from "@cubby/schemas/entity";
import type {
  EntityRecommendationsOut,
  ExpenseProjectProposal,
} from "@cubby/schemas/entity-recommendations";
import { parseShortcodeFor } from "@cubby/schemas/identifiers";

import { householdLocalDate } from "~/lib/household-date";
import type { Database } from "~/server/db";
import { expenseProjectRecommendationContext } from "~/server/repo/expense/project-recommendations";
import { getInventoryEntryByShortcode } from "~/server/repo/inventory";

import { getPlacementRecommendation } from "./placement-recommendation.service";
import {
  rankProjectSuggestions,
  type TradeAffinityCell,
} from "./project-suggestions";
import { getProductRelatedness } from "./relatedness.service";

async function expenseRecommendations(
  db: Database,
  source: EntityRef,
): Promise<EntityRecommendationsOut> {
  const context = await expenseProjectRecommendationContext(
    db,
    parseShortcodeFor("expense", source.entityId),
  );
  if (!context) return { source, basisKey: source.entityId, groups: [] };
  const { source: row, projects, history, currentTarget } = context;
  const counts = new Map<string, TradeAffinityCell>();
  for (const item of history) {
    const cell = counts.get(item.projectId) ?? {
      projectId: item.projectId,
      trade: row.trade,
      count: 0,
      exactProductCount: 0,
    };
    if (item.trade === row.trade) cell.count++;
    if (row.productId && item.productId === row.productId)
      cell.exactProductCount = (cell.exactProductCount ?? 0) + 1;
    counts.set(item.projectId, cell);
  }
  const proposals: ExpenseProjectProposal[] = rankProjectSuggestions(
    { date: row.date, trade: row.trade, projectId: currentTarget?.id },
    projects,
    [...counts.values()],
    householdLocalDate(),
  ).map((suggestion) => {
    const window = projects.find((item) => item.id === suggestion.id)!;
    const supportingExpenses = history
      .filter((item) => item.projectId === suggestion.id)
      .sort(
        (a, b) =>
          Number(b.productId === row.productId && row.productId !== null) -
            Number(a.productId === row.productId && row.productId !== null) ||
          a.name.localeCompare(b.name) ||
          a.id.localeCompare(b.id),
      )
      .slice(0, 3)
      .map(({ id, name }) => ({ id, name }));
    return {
      kind: "expense-project",
      expenseId: parseShortcodeFor("expense", row.shortcode),
      target: { id: window.id, name: window.name },
      effectiveStart: window.effectiveStart,
      effectiveEnd: window.effectiveEnd,
      sameTradeCount: suggestion.affinity,
      exactProductCount: suggestion.exactProductCount,
      supportingExpenses,
      reasons: [
        `Active on ${row.date}: ${window.effectiveStart} to ${window.effectiveEnd ?? "present"}`,
        `${suggestion.affinity} other ${row.trade} expenses`,
        ...(suggestion.exactProductCount > 0
          ? [
              `${suggestion.exactProductCount} other expenses for this exact product`,
            ]
          : []),
      ],
    };
  });
  return {
    source,
    basisKey: [
      row.shortcode,
      row.date,
      row.trade,
      row.productId,
      currentTarget?.id,
      row.updatedAt,
    ].join("|"),
    groups: [
      { kind: "expense-project", status: "ready", currentTarget, proposals },
    ],
  };
}

/** Shared read contract; action adapters keep their existing domain mutations. */
export async function getEntityRecommendations(
  db: Database,
  source: EntityRef,
): Promise<EntityRecommendationsOut> {
  if (source.entityType === "expense")
    return expenseRecommendations(db, source);
  if (source.entityType === "inventory") {
    const id = parseShortcodeFor("inventory", source.entityId);
    const [row, proposal] = await Promise.all([
      getInventoryEntryByShortcode(db, id),
      getPlacementRecommendation(db, id),
    ]);
    return {
      source,
      basisKey: [
        source.entityId,
        row?.location.id,
        row?.placement,
        row?.updatedAt,
      ].join("|"),
      groups: [
        {
          kind: "inventory-placement",
          status: "ready",
          currentTarget: row
            ? {
                id: parseShortcodeFor("location", row.location.id),
                name: row.location.name,
              }
            : null,
          proposals: proposal
            ? [
                {
                  kind: "inventory-placement",
                  inventoryId: proposal.inventoryId,
                  target: proposal.destination,
                  reasons: [
                    `${proposal.productName} is parked in ${proposal.sourceLocation.name}; another stock row for this exact product is in ${proposal.destination.name}.`,
                  ],
                },
              ]
            : [],
        },
      ],
    };
  }
  if (source.entityType === "product") {
    const related = await getProductRelatedness(
      db,
      parseShortcodeFor("product", source.entityId),
    );
    return {
      source,
      basisKey: source.entityId,
      groups: [
        {
          kind: "product-related",
          status: related.status,
          proposals: related.items.map((item) => ({
            kind: "product-related",
            target: {
              id: parseShortcodeFor("product", item.shortcode),
              name: item.title,
            },
            score: item.score,
            evidence: item.evidence,
          })),
        },
      ],
    };
  }
  return { source, basisKey: source.entityId, groups: [] };
}
