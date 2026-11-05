import { fieldProvenance } from "@cubby/schemas/field-envelope";
import { parseEntityId } from "@cubby/schemas/identifiers";
import { productCost } from "@cubby/schemas/product-fields";
import { and, isNull, sql } from "drizzle-orm";
/**
 * Product's stored derived values (ADR 0021): the effective price and the
 * ledger quantities, each the same SQL the list once evaluated per page.
 */

import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import { productOwnershipCompute } from "~/server/domains/inventory/repo/derived";
import {
  sharedDerivedPreparation,
  type DerivedCompute,
} from "~/server/generic/derived/repo/compute";

import { loadProductPriceFacts } from "./pricing";
import { loadProductQuantitySummaries } from "./quantity-ledger";

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

/** Legacy fixture adapters read the live view until the ticket engine retires. */
const computeServiceCost: DerivedCompute = async (db, ids) => {
  const rows = await unwrapDb(db)
    .execute(sql`SELECT "entityId", value, "sortNumber" FROM "ProductCostView"
    WHERE "entityId" = ANY(${uuidArrayParam(ids)})`);
  return new Map(
    rows.rows.map((row) => [
      String(row.entityId),
      {
        value: productCost.nullable().parse(row.value),
        sort: typeof row.sortNumber === "number" ? row.sortNumber : null,
      },
    ]),
  );
};

export const productDerivedComputes = {
  "product.ownership": productOwnershipCompute,
  "product.cost": Object.assign(computeServiceCost, {
    preparationBatchSize: 200,
  }),
  "product.price": Object.assign(computeProductPrice, {
    preparationBatchSize: 200,
  }),
  // Quantity folds aggregate in SQL; bounded pages amortize the full-pass round trips.
  "product.ledgerExpectedQuantity": Object.assign(
    computeProductQuantity("ledgerExpectedQuantity"),
    { preparationBatchSize: 200 },
  ),
  "product.quantityVariance": Object.assign(
    computeProductQuantity("quantityVariance"),
    { preparationBatchSize: 200 },
  ),
};
