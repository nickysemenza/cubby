import { publicImpactItemSchema } from "@cubby/schemas/entity-integrity";
import { sql } from "drizzle-orm";

import type { DrizzleTransaction } from "~/server/db";
import { createBlockedError } from "~/server/errors/app-error";

import { effectiveExpenseTradeSql } from "./expense-inheritance";
import { effectiveTaskTradeSql } from "./task-project-inheritance";

/** Validate the prospective graph before committing a source/default change. */
export async function validateLiveEffectiveTrades(
  tx: DrizzleTransaction,
): Promise<void> {
  const result = await tx.execute<{
    entity: string;
    shortcode: string;
    name: string;
  }>(sql`
    SELECT 'task' AS entity, t."shortcode", t."name"
    FROM "Task" t
    WHERE t."deletedAt" IS NULL AND ${effectiveTaskTradeSql("t")} IS NULL
    UNION ALL
    SELECT 'expense', e."shortcode", e."name"
    FROM "Expense" e
    WHERE e."deletedAt" IS NULL AND e."lineKind" = 'principal'
      AND ${effectiveExpenseTradeSql("e")} IS NULL
  `);
  if (result.rows.length === 0) return;
  throw createBlockedError(
    "CONSTRAINT_VIOLATION",
    "This change leaves required trades unresolved. Choose a trade or supply a default for the affected records.",
    result.rows.map((row) =>
      publicImpactItemSchema.parse({
        code: "required-trade-unresolved",
        effect: "block",
        label: row.name,
        description: `${row.shortcode} needs a trade after this change.`,
        total: 1,
        byTargetId: { [row.shortcode]: 1 },
      }),
    ),
  );
}
