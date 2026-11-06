import { spendingCategory } from "~/server/db/retained-tables";
import { qualityCheck } from "~/server/generic/data-quality/repo/builders";
import { defineStoredEntityChecks } from "~/server/generic/data-quality/repo/stored-registry";

const loadSpendingCategoryQualityRecords = qualityCheck.records(
  "spendingCategory",
  spendingCategory,
  {
    itemizationExpectation: spendingCategory.itemizationExpectation,
    productExpectation: spendingCategory.productExpectation,
  },
);

/** Bump when the rules or their declared scoring metadata change. */
const SPENDING_CATEGORY_QUALITY_RULES_VERSION = 1;

type SpendingCategoryQualityRecord = Awaited<
  ReturnType<typeof loadSpendingCategoryQualityRecords>
>[number];

// Policy readers use this category's own expectation. `not_expected` is a
// deliberate decision; only `unknown` remains a gap.
export const spendingCategoryChecks = defineStoredEntityChecks({
  entity: "spendingCategory",
  table: spendingCategory,
  rulesVersion: SPENDING_CATEGORY_QUALITY_RULES_VERSION,
  load: loadSpendingCategoryQualityRecords,
  checks: {
    spendingcategory_display_image: qualityCheck.hasImage,
    spending_category_itemization_expectation:
      qualityCheck.observed<SpendingCategoryQualityRecord>(
        (record) => record.itemizationExpectation !== "unknown",
      ),
    spending_category_product_expectation:
      qualityCheck.observed<SpendingCategoryQualityRecord>(
        (record) => record.productExpectation !== "unknown",
      ),
  },
});
