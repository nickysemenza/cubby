import { sql } from "drizzle-orm";

import {
  expectedQuantityReadSql,
  onHandUnitsReadSql,
} from "~/server/domains/product/repo/quantity-ledger";
import type { QualityReadContext } from "~/server/generic/data-quality/repo/registry";
import type {
  WorkCte,
  WorkScope,
} from "~/server/generic/work-queue/repo/work-source";

export const productWorkReadContext = (scope: WorkScope) => {
  const ctes: WorkCte[] = [];
  const context: QualityReadContext = {
    derivedValue: scope.record
      ? undefined
      : (field, id) => {
          if (field === "expectedQuantity") {
            if (!ctes.some((cte) => cte.name === "work_product_expected"))
              ctes.push({
                name: "work_product_expected",
                sql: expectedQuantityReadSql(),
              });
            return sql`((SELECT jsonb_object_agg("id", "value"::text) FROM work_product_expected) ->> ${id}::text)::double precision`;
          }
          if (field !== "onHandUnits") return undefined;
          if (!ctes.some((cte) => cte.name === "work_product_on_hand"))
            ctes.push({
              name: "work_product_on_hand",
              sql: onHandUnitsReadSql(),
            });
          return sql`((SELECT jsonb_object_agg("productId", "onHandUnits") FROM work_product_on_hand) ->> ${id}::text)::double precision`;
        },
  };
  return { context, ctes };
};
