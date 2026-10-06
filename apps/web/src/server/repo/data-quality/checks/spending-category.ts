import { sql } from "drizzle-orm";

import { spendingCategory } from "~/server/db/schema";

import { defineEntityChecks } from "../registry";

type SpendingCategory = typeof spendingCategory;

// The policy readers (`purchase-evidence-policy.ts`) take a category's own
// stored expectation with no parent fallback, so a child left `unknown`
// decides "unknown" wherever it is the governing policy. `not_expected` is a
// decision and satisfies the check.
export const spendingCategoryChecks = defineEntityChecks({
  entity: "spendingCategory",
  table: spendingCategory,
  checks: {
    spending_category_evidence_expectation: {
      missing: (t: SpendingCategory) =>
        sql`${t.evidenceExpectation} = 'unknown'`,
    },
    spending_category_product_expectation: {
      missing: (t: SpendingCategory) =>
        sql`${t.productExpectation} = 'unknown'`,
    },
  },
});
