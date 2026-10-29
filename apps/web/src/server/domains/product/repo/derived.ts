import { fieldProvenance } from "@cubby/schemas/field-envelope";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { productCost } from "@cubby/schemas/product-fields";
import { and, isNull, sql } from "drizzle-orm";
/**
 * Product's stored derived values (ADR 0021): the effective price and the
 * ledger quantities, each the same SQL the list once evaluated per page.
 */
import { alias } from "drizzle-orm/pg-core";

import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { actualExpenseSql, notDeleted } from "~/server/db/helpers/predicates";
import { outer, quotedTable } from "~/server/db/helpers/related";
import { product, expense } from "~/server/db/schema";
import { productOwnershipCompute } from "~/server/domains/inventory/repo/derived";
import { serviceProductSqlText } from "~/server/domains/product/repo/service-category";
import {
  sharedDerivedPreparation,
  type DerivedCompute,
  type DerivedComputed,
} from "~/server/generic/derived/repo/compute";

import { loadProductPriceFacts } from "./pricing";
import { loadProductQuantitySummaries } from "./quantity-ledger";

const row = quotedTable(product);
const charge = alias(expense, "e");

const computeProductPrice: DerivedCompute = async (db, ids) => {
  const rows = await unwrapDb(db)
    .select({ id: product.id, price: product.price })
    .from(product)
    .where(
      and(
        isNull(product.deletedAt),
        sql`${product.id} = ANY(${uuidArrayParam(ids)})`,
      ),
    );
  const facts = await loadProductPriceFacts(db, rows);
  return new Map(
    [...facts].map(([id, { value, evidence }]) => [
      id,
      {
        value,
        sort: value,
        decision: {
          outcome:
            value === null
              ? {
                  kind: "empty" as const,
                  reason: evidence.service
                    ? ("not_applicable" as const)
                    : ("unset" as const),
                }
              : { kind: "value" as const },
          provenance:
            evidence.manualPrice !== null && !evidence.service
              ? fieldProvenance.parse({
                  kind: "own",
                  ownership: { kind: "record" },
                })
              : fieldProvenance.parse({ kind: "computed" }),
          evidence,
        },
      },
    ]),
  );
};

const quantityPreparation = sharedDerivedPreparation((db, ids) =>
  loadProductQuantitySummaries(
    db,
    ids.map((id) => parseEntityId("product", id)),
  ),
);
const computeProductQuantity = (
  key: "ledgerExpectedQuantity" | "quantityVariance",
): DerivedCompute =>
  quantityPreparation((summaries, ids) => {
    const wanted = new Set(ids);
    return new Map(
      [...summaries]
        .filter(([id]) => wanted.has(id))
        .map(([id, summary]) => {
          const value =
            key === "ledgerExpectedQuantity"
              ? summary.quantityLedger.expectedQuantity
              : summary.quantityVariance;
          return [
            id,
            {
              value,
              sort: value,
              decision: {
                outcome:
                  value === null
                    ? { kind: "empty" as const, reason: "unset" as const }
                    : { kind: "value" as const },
                provenance: fieldProvenance.parse({ kind: "computed" }),
                evidence: summary,
              },
            },
          ];
        }),
    );
  });

/** Only services publish Cost; physical Cost projects the selected price read. */
const computeServiceCost: DerivedCompute = async (db, ids) => {
  const rows = await unwrapDb(db)
    .select({
      id: product.id,
      value: sql`(SELECT CASE WHEN count(*) > 0 THEN jsonb_build_object(
      ${productCost.options[1].keyof().enum.kind}::text, ${productCost.options[1].shape.kind.value}::text,
      'amount', round(avg(e."cost")::numeric, 2)::double precision,
      'chargeCount', count(*)::int,
      'chargeTotal', sum(e."cost"::double precision),
      'latestCharge', (array_agg(e."cost" ORDER BY e."date" DESC, e."id" DESC)
        FILTER (WHERE e."date" IS NOT NULL))[1]::double precision) END
      FROM "Expense" e WHERE e."productId" = ${outer(product.id)}
        AND ${notDeleted(charge)} AND ${sql.raw(actualExpenseSql("e"))} AND e."cost" > 0)`,
    })
    .from(product)
    .where(
      and(
        sql`${product.id} = ANY(${uuidArrayParam(ids)})`,
        isNull(product.deletedAt),
        sql.raw(serviceProductSqlText(`${row}."id"`)),
      ),
    );
  const out = new Map<string, DerivedComputed>();
  for (const result of rows) {
    const value = productCost.nullable().parse(result.value);
    out.set(String(result.id), { value, sort: value?.amount ?? null });
  }
  return out;
};

export const productDerivedComputes = {
  "product.ownership": productOwnershipCompute,
  "product.cost": computeServiceCost,
  "product.price": computeProductPrice,
  "product.ledgerExpectedQuantity": computeProductQuantity(
    "ledgerExpectedQuantity",
  ),
  "product.quantityVariance": computeProductQuantity("quantityVariance"),
};
