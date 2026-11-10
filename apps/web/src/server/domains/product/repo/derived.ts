import { fieldProvenance } from "@cubby/schemas/field-envelope";
import { and, isNull, sql } from "drizzle-orm";
/**
 * Product's stored derived values (ADR 0021): the effective price and the
 * owner collection. Ledger quantities are live SQL.
 */

import { unwrapDb, uuidArrayParam } from "~/server/db/helpers";
import { product } from "~/server/db/schema";
import { productOwnershipCompute } from "~/server/domains/inventory/repo/derived";
import type { DerivedCompute } from "~/server/generic/derived/repo/compute";

import { loadProductPriceFacts } from "./pricing";

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

export const productDerivedComputes = {
  "product.ownership": Object.assign(productOwnershipCompute, {
    preparationBatchSize: 100,
  }),
  "product.price": Object.assign(computeProductPrice, {
    preparationBatchSize: 200,
  }),
};
