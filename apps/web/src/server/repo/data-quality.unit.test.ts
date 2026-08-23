import {
  productDataCheck,
  purchaseDataCheck,
} from "@cubby/schemas/data-quality";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  productAnyDataGapCondition,
  productDataGapCondition,
  productDefectCondition,
  productNeedsDataCondition,
  purchaseAnyDataGapCondition,
  purchaseDataGapCondition,
  purchaseDefectCondition,
  purchaseNeedsDataCondition,
} from "./data-quality";

const dialect = new PgDialect();

/**
 * True when the whole expression sits inside ONE outer paren pair — i.e. the
 * opening paren's partner is the final character. `(a) AND (b)` is balanced but
 * NOT grouped, and that is precisely the shape that breaks under `NOT`.
 */
const isSingleGroup = (condition: SQL): boolean => {
  const rendered = dialect.sqlToQuery(condition).sql.trim();
  if (!rendered.startsWith("(")) return false;
  let depth = 0;
  for (let i = 0; i < rendered.length; i++) {
    if (rendered[i] === "(") depth++;
    else if (rendered[i] === ")") {
      depth--;
      if (depth === 0) return i === rendered.length - 1;
    }
  }
  return false;
};

/**
 * ⚠️ REGRESSION GUARD for a SQL operator-precedence bug that silently emptied a
 * worklist. `productDataGapCondition` returned a bare
 * `scope AND missing AND NOT exception`; `productNeedsDataCondition` embeds it
 * as `NOT <that>`, where `NOT` binds tighter than `AND` and so applied to
 * `scope` alone. The result AND-ed `NOT scope` against a missing-data group
 * that requires the same scope — a contradiction — and `dataStatus:
 * "needs_data"` matched ZERO products in production while 1,193 real gaps
 * existed. `dataStatus: "complete"` is `NOT <anyDataGap>` and broke the same
 * way, reporting defective rows as clean.
 *
 * Every builder here is embedded under `NOT` or inside a larger boolean tree by
 * at least one caller, so each must render as ONE parenthesized group. Asserted
 * on the rendered SQL because the bug is invisible in the TypeScript — the
 * template literals compose without complaint and only the operator precedence
 * of the emitted string is wrong.
 */
describe("data-quality predicate grouping", () => {
  const builders: Array<[string, () => SQL]> = [
    ["productNeedsDataCondition", productNeedsDataCondition],
    ["productAnyDataGapCondition", productAnyDataGapCondition],
    ["productDefectCondition", productDefectCondition],
    ["purchaseNeedsDataCondition", purchaseNeedsDataCondition],
    ["purchaseAnyDataGapCondition", purchaseAnyDataGapCondition],
    ["purchaseDefectCondition", purchaseDefectCondition],
  ];

  it.each(builders)(
    "%s renders as a single parenthesized group",
    (_, build) => {
      expect(isSingleGroup(build())).toBe(true);
    },
  );

  it.each(productDataCheck.options)(
    "productDataGapCondition(%s) renders as a single parenthesized group",
    (check) => {
      expect(isSingleGroup(productDataGapCondition(check))).toBe(true);
    },
  );

  // `purchaseDataGapCondition` dispatches on BOTH enums — a purchase rolls up
  // its linked products' gaps — so both halves are covered here.
  it.each([...purchaseDataCheck.options, ...productDataCheck.options])(
    "purchaseDataGapCondition(%s) renders as a single parenthesized group",
    (check) => {
      expect(isSingleGroup(purchaseDataGapCondition(check))).toBe(true);
    },
  );
});
