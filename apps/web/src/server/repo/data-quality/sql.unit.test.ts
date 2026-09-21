import {
  dataExceptionReason,
  dataQualityExceptionEntities,
  dataQualityStatus,
  relatedDataQualityEntities,
  scoredEntities,
} from "@cubby/schemas/data-quality";
import { getTableName, type SQL } from "drizzle-orm";
import { alias, PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { product } from "~/server/db/schema";

import { dataQualityEntries } from "./entries";
import { calculateDataQualityScore } from "./hydrate";
import {
  anyGapCondition,
  checksOf,
  dataQualityFilterPredicates,
  defectCondition,
  entryFor,
  filterableChecks,
  gapCondition,
  relatedGapCondition,
  scoreSql,
  statusCondition,
} from "./sql";

const dialect = new PgDialect();
const render = (condition: SQL) => dialect.sqlToQuery(condition).sql;

/**
 * True when the whole expression sits inside ONE outer paren pair — i.e. the
 * opening paren's partner is the final character. `(a) AND (b)` is balanced but
 * NOT grouped, and that is precisely the shape that breaks under `NOT`.
 */
const isSingleGroup = (condition: SQL): boolean => {
  const rendered = render(condition).trim();
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
 * worklist. A gap builder once returned a bare `scope AND missing AND NOT
 * exception`; the needs-data builder embeds it as `NOT <that>`, where `NOT`
 * binds tighter than `AND` and so applied to `scope` alone — a contradiction
 * that matched ZERO products while 1,193 real gaps existed. `dataStatus:
 * "complete"` is `NOT <anyGap>` and broke the same way.
 *
 * Every builder is embedded under `NOT` or inside a larger boolean tree by at
 * least one caller, so each must render as ONE parenthesized group. Asserted
 * on the rendered SQL because the bug is invisible in the TypeScript. Iterates
 * the registry so a newly declared entity or check is covered automatically.
 */
describe("data-quality predicate grouping", () => {
  const builders = scoredEntities.flatMap((entity) => [
    ...dataQualityStatus.options.map(
      (status) =>
        [
          `statusCondition(${entity}, ${status})`,
          () => statusCondition(entity, status),
        ] as const,
    ),
    [`anyGapCondition(${entity})`, () => anyGapCondition(entity)] as const,
    [`defectCondition(${entity})`, () => defectCondition(entity)] as const,
    [`scoreSql(${entity})`, () => scoreSql(entity)] as const,
    ...checksOf(entity).map(
      (check) =>
        [
          `gapCondition(${entity}, ${check})`,
          () => gapCondition(entity, check),
        ] as const,
    ),
    ...relatedDataQualityEntities[entity].flatMap((related) =>
      checksOf(related).map(
        (check) =>
          [
            `relatedGapCondition(${entity}, ${check})`,
            () => relatedGapCondition(entity, check),
          ] as const,
      ),
    ),
  ]);

  it.each(builders)(
    "%s renders as a single parenthesized group",
    (_, build) => {
      expect(isSingleGroup(build())).toBe(true);
    },
  );
});

/** The manifest and the SQL registry must describe the same checks. */
describe("data-quality registry", () => {
  it.each(scoredEntities)("%s binds exactly its declared checks", (entity) => {
    const entry = entryFor(entity);
    expect(entry.entity).toBe(entity);
    expect(Object.keys(entry.checks).sort()).toEqual(
      [...checksOf(entity)].sort(),
    );
    expect(Object.keys(entry.related ?? {}).sort()).toEqual(
      [...relatedDataQualityEntities[entity]].sort(),
    );
  });

  // An exception is keyed by the check's evidence fingerprint, so every check
  // of an exception-bearing entity must declare its inputs.
  it.each(
    scoredEntities.filter((entity) => dataQualityExceptionEntities[entity]),
  )("%s declares fingerprint inputs for every check", (entity) => {
    const entry = entryFor(entity);
    expect(entry.exceptions).toBeDefined();
    expect(
      Object.entries(entry.checks).flatMap(([check, binding]) =>
        binding.fingerprint ? [] : [check],
      ),
    ).toEqual([]);
  });

  it("registers every scored entity and nothing else", () => {
    expect(Object.keys(dataQualityEntries).sort()).toEqual(
      [...scoredEntities].sort(),
    );
  });
});

describe("calculateDataQualityScore", () => {
  const gap = (check: "product_image" | "product_manufacturer") => ({ check });

  it("treats no expected checks as complete", () => {
    expect(calculateDataQualityScore([], [])).toBe(100);
  });

  it("weights unresolved gaps by the check's declared weight", () => {
    // manufacturer weighs 3, image 1: a missing image costs 25, not 50.
    expect(
      calculateDataQualityScore(
        ["product_manufacturer", "product_image"],
        [gap("product_image")],
      ),
    ).toBe(75);
    expect(
      calculateDataQualityScore(
        ["product_manufacturer", "product_image"],
        [gap("product_manufacturer")],
      ),
    ).toBe(25);
  });

  it("ignores a gap on a check that is not expected", () => {
    expect(
      calculateDataQualityScore(
        ["product_manufacturer"],
        [gap("product_image")],
      ),
    ).toBe(100);
  });
});

describe("aliased evaluation", () => {
  it("renders a related row's check against the alias, not the base table", () => {
    const related = alias(product, "dq_r");
    const rendered = render(
      gapCondition("product", "product_manufacturer", related),
    );
    expect(rendered).toContain('"dq_r"."manufacturer"');
    expect(rendered).not.toContain('"Product"."manufacturer"');
    expect(getTableName(related)).toBe("dq_r");
  });

  it("rolls a related check up through the owner's link predicate", () => {
    const rendered = render(relatedGapCondition("purchase", "product_image"));
    expect(rendered).toContain('FROM "Product" "dq_r"');
    expect(rendered).toContain('dq_pe."purchaseId" = "Purchase"."id"');
  });
});

describe("purchase import expectations", () => {
  it("gates receipt and line checks by the vendor's order-evidence policy", () => {
    const documentSql = render(gapCondition("purchase", "primary_document"));
    const expenseSql = render(gapCondition("purchase", "empty_expenses"));
    expect(documentSql).toContain('"orderEvidence"');
    expect(documentSql).toContain("receipt_only");
    expect(expenseSql).toContain('"orderEvidence"');
    expect(expenseSql).toContain("online_account");
    expect(expenseSql).not.toContain("receipt_only");
  });

  it("uses check inputs, not target timestamps, to keep an exception active", () => {
    const productSql = render(gapCondition("product", "product_manufacturer"));
    const purchaseSql = render(gapCondition("purchase", "paperwork_mismatch"));
    expect(productSql).toContain("to_jsonb");
    expect(purchaseSql).toContain("to_jsonb");
    expect(productSql).not.toContain('"updatedAt"');
    expect(purchaseSql).not.toContain('"updatedAt"');
  });

  it("preserves typed unavailable-history exceptions", () => {
    expect(dataExceptionReason.parse("history_expired")).toBe(
      "history_expired",
    );
  });
});

describe("dataQualityFilterPredicates", () => {
  it("accepts one-or-many values and routes related checks to the roll-up", () => {
    const table = entryFor("purchase").table;
    expect(filterableChecks("purchase")).toContain("product_image");
    const predicates = dataQualityFilterPredicates("purchase", table, {
      dataStatus: ["needs_data"],
      dataGap: ["order_id", "product_image", "not_a_check"],
    });
    expect(predicates).toHaveLength(2);
    const gaps = render(predicates[1]!);
    expect(gaps).toContain('"Purchase"."orderId" IS NULL');
    expect(gaps).toContain('FROM "Product" "dq_r"');
    expect(gaps).not.toContain("not_a_check");
  });

  it("emits nothing for filters that name no data-quality field", () => {
    expect(
      dataQualityFilterPredicates("product", entryFor("product").table, {
        nameFilter: "x",
      }),
    ).toEqual([]);
  });
});
