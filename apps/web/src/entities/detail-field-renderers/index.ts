import { entityFieldModels } from "@cubby/schemas/entity-fields";
import type { DetailRendererId } from "@cubby/schemas/entity-manifest";

import type {
  DetailRecordOf,
  GenericDetailEntity,
} from "~/app/_components/entity-detail/detail-record";

import type { DetailFieldRenderer } from "../entity-display";
import {
  implemented,
  type PresentationCoverage,
} from "../presentation-coverage";
import { expenseDetailFields } from "./expense";
import { financialAccountDetailFields } from "./financial-account";
import { financialTransactionDetailFields } from "./financial-transaction";
import { inventoryDetailFields } from "./inventory";
import { ledgerTransferDetailFields } from "./ledger-transfer";
import { productDetailFields } from "./product";
import { productCategoryDetailFields } from "./product-category";
import { recipeDetailFields } from "./recipe";
import { vendorDetailFields } from "./vendor";
import { wishDetailFields } from "./wish";

export type EntityDetailFieldRenderers<E extends GenericDetailEntity> =
  Readonly<Record<DetailRendererId<E>, DetailFieldRenderer<DetailRecordOf<E>>>>;

type DetailRendererEntity = {
  [E in GenericDetailEntity]: DetailRendererId<E> extends never ? never : E;
}[GenericDetailEntity];

type EntityDetailRendererCoverage<E extends DetailRendererEntity> = Readonly<
  Record<
    DetailRendererId<E>,
    PresentationCoverage<DetailFieldRenderer<DetailRecordOf<E>>>
  >
>;

/**
 * Domain rendering for the detail fields whose value is not a scalar — a
 * structured JSON column, an external-id list, a barcode that reads
 * differently as an ISBN. Every other field renders generically
 * (`renderDetailFieldValue`); a JSON field with no entry here shows as
 * readable JSON rather than failing.
 */
export const detailRendererCoverage = {
  inventory: {
    ownershipMode: implemented(inventoryDetailFields.ownershipMode),
    ownerLedgerPartyId: implemented(inventoryDetailFields.ownerLedgerPartyId),
    effectiveOwnership: implemented(inventoryDetailFields.effectiveOwnership),
  },
  expense: {
    "expense-project": implemented(expenseDetailFields["expense-project"]),
  },
  product: {
    "product-id": implemented(productDetailFields["product-id"]),
    "product-primary-gtin": implemented(
      productDetailFields["product-primary-gtin"],
    ),
    "product-fdc-id": implemented(productDetailFields["product-fdc-id"]),
    "product-ingredient": implemented(
      productDetailFields["product-ingredient"],
    ),
    "product-external-ids": implemented(
      productDetailFields["product-external-ids"],
    ),
    "product-tags": implemented(productDetailFields["product-tags"]),
  },
  productCategory: {
    "product-category-path": implemented(
      productCategoryDetailFields["product-category-path"],
    ),
  },
  recipe: {
    "recipe-meta": implemented(recipeDetailFields["recipe-meta"]),
    "recipe-yield": implemented(recipeDetailFields["recipe-yield"]),
    "recipe-source": implemented(recipeDetailFields["recipe-source"]),
    "recipe-sections": implemented(recipeDetailFields["recipe-sections"]),
    "recipe-totals": implemented(recipeDetailFields["recipe-totals"]),
  },
  vendor: {
    "vendor-agent-hints": implemented(vendorDetailFields["vendor-agent-hints"]),
  },
  financialAccount: {
    "financial-account-identity": implemented(
      financialAccountDetailFields["financial-account-identity"],
    ),
    "financial-account-source-aliases": implemented(
      financialAccountDetailFields["financial-account-source-aliases"],
    ),
    "financial-account-card-numbers": implemented(
      financialAccountDetailFields["financial-account-card-numbers"],
    ),
  },
  financialTransaction: {
    "financial-transaction-vendor-inference": implemented(
      financialTransactionDetailFields[
        "financial-transaction-vendor-inference"
      ],
    ),
    "financial-transaction-allocations": implemented(
      financialTransactionDetailFields["financial-transaction-allocations"],
    ),
    "financial-transaction-source-refs": implemented(
      financialTransactionDetailFields["financial-transaction-source-refs"],
    ),
  },
  ledgerTransfer: {
    "ledger-transfer-classification": implemented(
      ledgerTransferDetailFields["ledger-transfer-classification"],
    ),
  },
  wish: {
    "wish-candidates": implemented(wishDetailFields["wish-candidates"]),
  },
} satisfies {
  [E in DetailRendererEntity]: EntityDetailRendererCoverage<E>;
};

type ErasedDetailCoverage = Readonly<
  Record<string, PresentationCoverage<DetailFieldRenderer<never>>>
>;

const detailCoverageFor = (
  entity: GenericDetailEntity,
): ErasedDetailCoverage | undefined => {
  switch (entity) {
    case "inventory":
      return detailRendererCoverage.inventory;
    case "expense":
      return detailRendererCoverage.expense;
    case "product":
      return detailRendererCoverage.product;
    case "productCategory":
      return detailRendererCoverage.productCategory;
    case "recipe":
      return detailRendererCoverage.recipe;
    case "vendor":
      return detailRendererCoverage.vendor;
    case "financialAccount":
      return detailRendererCoverage.financialAccount;
    case "financialTransaction":
      return detailRendererCoverage.financialTransaction;
    case "ledgerTransfer":
      return detailRendererCoverage.ledgerTransfer;
    case "wish":
      return detailRendererCoverage.wish;
    default:
      return undefined;
  }
};

/** The renderers for one entity, read through the erased map the page walks. */
export const detailFieldRenderersFor = (
  entity: GenericDetailEntity,
): Readonly<Record<string, DetailFieldRenderer<never>>> | undefined => {
  const coverage = detailCoverageFor(entity);
  const entries = entityFieldModels[entity].fields.flatMap((field) => {
    const renderer = field.display.renderer?.detail;
    if (renderer === null || renderer === undefined) return [];
    const disposition = coverage?.[renderer];
    if (disposition === undefined) {
      throw new Error(`No web detail renderer coverage for ${renderer}`);
    }
    if (disposition.kind !== "implemented") {
      throw new Error(`Web detail renderer ${renderer} is not implemented`);
    }
    return [[field.key, disposition.implementation] as const];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};
