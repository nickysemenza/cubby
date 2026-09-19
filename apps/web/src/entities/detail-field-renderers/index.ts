import type {
  DetailRecordOf,
  GenericDetailEntity,
} from "~/app/_components/entity-detail/detail-record";

import type { DetailFieldRenderer } from "../entity-display";
import { expenseDetailFields } from "./expense";
import { financialAccountDetailFields } from "./financial-account";
import { financialTransactionDetailFields } from "./financial-transaction";
import { ledgerTransferDetailFields } from "./ledger-transfer";
import { productDetailFields } from "./product";
import { recipeDetailFields } from "./recipe";
import { vendorDetailFields } from "./vendor";
import { wishDetailFields } from "./wish";

export type EntityDetailFieldRenderers<E extends GenericDetailEntity> =
  Readonly<Partial<Record<string, DetailFieldRenderer<DetailRecordOf<E>>>>>;

/**
 * Domain rendering for the detail fields whose value is not a scalar — a
 * structured JSON column, an external-id list, a barcode that reads
 * differently as an ISBN. Every other field renders generically
 * (`renderDetailFieldValue`); a JSON field with no entry here shows as
 * readable JSON rather than failing.
 */
export const detailFieldRenderers = {
  expense: expenseDetailFields,
  product: productDetailFields,
  recipe: recipeDetailFields,
  vendor: vendorDetailFields,
  financialAccount: financialAccountDetailFields,
  financialTransaction: financialTransactionDetailFields,
  ledgerTransfer: ledgerTransferDetailFields,
  wish: wishDetailFields,
} satisfies { [E in GenericDetailEntity]?: EntityDetailFieldRenderers<E> };

/** The renderers for one entity, read through the erased map the page walks. */
export const detailFieldRenderersFor = (
  entity: GenericDetailEntity,
): Readonly<Record<string, DetailFieldRenderer<never>>> | undefined =>
  Object.hasOwn(detailFieldRenderers, entity)
    ? // SAFETY: `hasOwn` proves `entity` is one of the registry's own keys.
      detailFieldRenderers[entity as keyof typeof detailFieldRenderers]
    : undefined;
